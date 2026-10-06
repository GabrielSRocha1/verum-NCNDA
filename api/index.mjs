// Entrada serverless (Vercel). Reaproveita o MESMO app Fastify de src/ — o servidor de processo
// longo (src/server.ts) segue sendo o caminho de referência; aqui só a entrada muda.
//
// Por que .mjs e não .ts: este projeto não é compilado. O Node executa os .ts direto
// (type-stripping nativo, engines.node ">=22.18") e por isso os imports trazem a extensão .ts
// explícita. Um handler em .ts seria compilado pela plataforma, e aí esses especificadores podem
// não resolver mais. Em JavaScript puro a plataforma não mexe neste arquivo, e quem carrega o
// app é o Node, igual ao local.
//
// O import do app é DINÂMICO e fica dentro do try de propósito: com import estático, qualquer erro
// ao carregar o módulo mata a função antes de o handler existir e a plataforma devolve um 500
// FUNCTION_INVOCATION_FAILED opaco, que não diz o que quebrou. Assim o erro vira log e resposta.
//
// Duas diferenças que valem saber, porque mudam comportamento e não só desempenho:
//  1. O rate limit por IP (src/lib/common.ts) vive na memória da instância, então conta por
//     instância, não global. A defesa dura contra chute do código do convite não é essa: é o
//     contador no banco, que BLOQUEIA o convite em 5 erros (src/services/invitations.ts).
//  2. O varredor periódico de convites expirados (setInterval em src/app.ts) não roda num processo
//     que só vive durante a requisição. A expiração continua acontecendo porque toda rota de
//     convite varre antes de responder — só não acontece com ninguém olhando.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let booting = null;

function boot() {
  booting ??= (async () => {
    const { buildApp } = await import('../src/app.ts');
    const built = await buildApp({ logger: false });
    await built.app.ready();
    return built;
  })();
  return booting;
}

/** Fatos do ambiente que explicam a maioria das falhas de boot sem precisar de outro deploy. */
function ambiente() {
  const checar = (p) => { try { return existsSync(resolve(process.cwd(), p)); } catch { return false; } };
  return {
    node: process.version,
    cwd: process.cwd(),
    moduloEm: import.meta.url,
    temSrcApp: checar('src/app.ts'),
    temPublicIndex: checar('public/index.html'),
    temMigration: checar('migrations/001_schema.sql'),
    temDatabaseUrl: Boolean(process.env.DATABASE_URL),
    temSegredos: Boolean(process.env.SESSION_SECRET) && Boolean(process.env.INVITE_PEPPER),
  };
}

export default async function handler(req, res) {
  let built;
  try {
    built = await boot();
  } catch (e) {
    // Falha de boot não pode envenenar a instância: sem isto a Promise rejeitada ficaria em cache
    // e TODA requisição seguinte falharia igual, mesmo depois de o problema passar.
    booting = null;
    console.error('Falha ao iniciar o app:', e?.stack ?? e?.message ?? e);
    console.error('Ambiente:', JSON.stringify(ambiente()));
    // O motivo só sai na resposta com BOOT_DIAGNOSTICS=1: em operação normal fica no log, porque
    // mensagem de erro de inicialização conta coisas da infraestrutura para quem pede.
    const detalhe = process.env.BOOT_DIAGNOSTICS === '1'
      ? { detail: e?.message ?? String(e), code: e?.code ?? null, stack: String(e?.stack ?? '').split('\n').slice(0, 8), ambiente: ambiente() }
      : {};
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: 'UNAVAILABLE', message: 'Servidor indisponível neste momento. Tente novamente.', ...detalhe }));
    return;
  }
  built.app.server.emit('request', req, res);
}
