// Comando de acesso: ver, aprovar e recusar solicitações. É o ÚNICO caminho do sistema que cria
// conta sem convite — e por isso roda no servidor, por quem opera, nunca por rota HTTP.
//
//   npm run access -- list [--status=PENDENTE|APROVADO|RECUSADO]
//   npm run access -- approve <id|e-mail|carteira> [--por="seu nome"]
//   npm run access -- reject  <id|e-mail|carteira> [--por="seu nome"] [--motivo="..."]
//   npm run access -- purge   [--dias=90]
//   npm run access -- test-email <destino>
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

const [acao, ...resto] = process.argv.slice(2);
const flags = new Map<string, string>();
const livres: string[] = [];
for (const a of resto) {
  const m = a.match(/^--([a-zA-Z]+)(?:=(.*))?$/);
  if (m) flags.set(m[1].toLowerCase(), m[2] ?? 'true');
  else livres.push(a);
}
const alvo = livres[0];

const USO = `
Uso:
  npm run access -- list [--status=PENDENTE]
  npm run access -- approve <id|e-mail|carteira> [--por="seu nome"]
  npm run access -- reject  <id|e-mail|carteira> [--por="seu nome"] [--motivo="..."]
  npm run access -- purge   [--dias=90]
  npm run access -- test-email <destino>      # confere host, porta, SSL e senha
`;

if (!acao || ['help', '--help', '-h'].includes(acao)) { console.log(USO); process.exit(0); }
if (!['list', 'approve', 'reject', 'purge', 'test-email'].includes(acao)) {
  console.error(`Ação desconhecida: ${acao}${USO}`);
  process.exit(1);
}
if (['approve', 'reject', 'test-email'].includes(acao) && !alvo) {
  console.error(`A ação "${acao}" precisa de um id, e-mail ou carteira.${USO}`);
  process.exit(1);
}

// O app é importado DEPOIS do .env, como nos outros scripts: buildApp lê a configuração no import.
const { buildApp } = await import('../src/app.ts');
const access = await import('../src/services/access.ts');

// seed: false — este comando mexe em dados reais; não é hora de semear DEMO.
const { app, ctx, db } = await buildApp({ seed: false, logger: false });
const fecha = async () => { await app.close(); };

// Banco local (PGlite) é de processo único: dois processos no mesmo diretório podem corromper os
// dados. Com DATABASE_URL (Postgres de servidor) não há esse limite — é o caso do deploy.
if (db.kind === 'pglite' && ['approve', 'reject', 'purge'].includes(acao)) {
  console.warn(`\nAVISO: banco local em ${ctx.cfg.dataDir}. Pare o servidor antes de gravar por aqui.`);
  console.warn('Com DATABASE_URL (Postgres de servidor) o comando roda com o app no ar, sem conflito.\n');
}

const dt = (v: string | null) => (v ? new Date(v).toLocaleString('pt-BR') : '—');
const curto = (w: string) => `${w.slice(0, 4)}...${w.slice(-4)}`;

try {
  if (acao === 'list') {
    const status = flags.get('status')?.toUpperCase() as any;
    if (status && !['PENDENTE', 'APROVADO', 'RECUSADO'].includes(status)) {
      throw new Error(`--status aceita PENDENTE, APROVADO ou RECUSADO (recebi "${status}").`);
    }
    const rows = await access.listRequests(db, status);
    if (!rows.length) {
      console.log(status ? `\nNenhuma solicitação ${status}.\n` : '\nNenhuma solicitação registrada.\n');
    } else {
      console.log(`\n${rows.length} solicitação(ões)${status ? ` ${status}` : ''}:\n`);
      for (const r of rows) {
        console.log(`  ${r.status.padEnd(9)} ${r.id}`);
        console.log(`    ${r.full_name} · ${r.organization} · ${r.country}`);
        console.log(`    ${r.email} · ${r.phone}`);
        console.log(`    carteira ${curto(r.wallet)} (comprovada por assinatura)`);
        if (r.referral) console.log(`    indicado por: ${r.referral}`);
        if (r.note) console.log(`    observação: ${r.note}`);
        console.log(`    solicitado em ${dt(r.created_at)}${r.decided_at ? ` · decidido em ${dt(r.decided_at)} por ${r.decided_by}` : ''}`);
        if (r.decision_note) console.log(`    motivo: ${r.decision_note}`);
        console.log('');
      }
      const pend = rows.filter((r) => r.status === 'PENDENTE').length;
      if (pend) console.log(`Para aprovar:  npm run access -- approve <id> --por="seu nome"\n`);
    }
  }

  if (acao === 'approve') {
    const { request, userId, envio } = await access.approveRequest(ctx, alvo!, flags.get('por') ?? '');
    console.log(`\nAprovado: ${request.full_name} <${request.email}>`);
    console.log(`Usuário criado: ${userId}`);
    console.log(`Carteira registrada: ${request.wallet} (rede ${ctx.cfg.network})`);
    // A conta já existe: falha de e-mail é aviso, não desfaz nada. Mas você precisa SABER, senão
    // a pessoa fica esperando um retorno que não saiu.
    console.log(envio.ok ? 'E-mail de aprovação enviado.' : `E-mail NÃO enviado: ${envio.motivo}\n→ avise a pessoa por fora.`);
    console.log(`\nAgora essa pessoa entra sozinha em ${ctx.cfg.publicOrigin} pela Verum Wallet,`);
    console.log(`cria a própria mesa e gera os convites para os indicados.\n`);
  }

  if (acao === 'reject') {
    const r = await access.rejectRequest(ctx, alvo!, flags.get('por') ?? '', flags.get('motivo') ?? null);
    console.log(`\nRecusada a solicitação de ${r.full_name} <${r.email}>.`);
    console.log(r.envio.ok ? 'E-mail de retorno enviado.' : `E-mail NÃO enviado: ${r.envio.motivo}`);
    console.log('Nenhuma conta foi criada.\n');
  }

  if (acao === 'test-email') {
    if (!ctx.mail.enabled) throw new Error('Envio desligado: defina SMTP_PASS (e SMTP_USER) no ambiente.');
    const smtp = ctx.cfg.smtp!;
    console.log(`\nServidor: ${smtp.host}:${smtp.port} ${smtp.port === 465 ? '(SSL)' : '(STARTTLS)'}`);
    console.log(`Remetente: ${ctx.mail.remetente}`);
    const v = await ctx.mail.verify();
    console.log(v.ok ? 'Conexão e senha: OK' : `Conexão/senha FALHOU: ${v.motivo}`);
    if (!v.ok) { await fecha(); process.exit(1); }
    const r = await ctx.mail.send({
      para: alvo!,
      assunto: 'Teste de envio — VERUM NCNDA',
      texto: 'Se você recebeu esta mensagem, o envio de e-mail da mesa está funcionando.\n\nVERUM NCNDA',
    });
    console.log(r.ok ? `Mensagem de teste enviada para ${alvo}.\n` : `Envio FALHOU: ${r.motivo}\n`);
    if (!r.ok) { await fecha(); process.exit(1); }
  }

  if (acao === 'purge') {
    const dias = Number(flags.get('dias') ?? 90);
    if (!Number.isInteger(dias) || dias < 1) throw new Error('--dias precisa ser um inteiro positivo.');
    const n = await access.purgeRejected(ctx, dias);
    console.log(`\n${n} solicitação(ões) recusada(s) há mais de ${dias} dias foram descartadas.\n`);
  }
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  await fecha();
  process.exit(1);
}

await fecha();
