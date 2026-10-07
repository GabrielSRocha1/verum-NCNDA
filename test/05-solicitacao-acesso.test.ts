// Solicitação de acesso: como o PRIMEIRO Pay Master entra, já que não há convite para lhe dar.
// O que estes testes travam: a rota só existe quando ligada, solicitar não cria conta, a carteira
// é comprovada por assinatura, e só o comando de aprovação cria o cadastro.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { base58Encode } from '../src/lib/crypto.ts';
import { demoAddress } from '../src/demo.ts';
import * as access from '../src/services/access.ts';

const env = { DATA_DIR: 'memory', DEMO_MODE: 'true', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: 'http://localhost:8787', ACCESS_REQUESTS: 'on' } as any;
let app: BuiltApp;
let ipCounter = 0;
const freshIp = () => `10.5.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const cookieOf = (res: any, name: string): string | undefined => {
  const raw = res.headers['set-cookie']; const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x: string) => x.startsWith(name + '='));
  return c ? c.split(';')[0] : undefined;
};

/** Solicita acesso com uma carteira nova, provando a posse por assinatura. */
async function solicitar(dados: Partial<Record<string, string>> = {}, kp = nacl.sign.keyPair()) {
  const address = base58Encode(kp.publicKey);
  const ch = await app.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  assert.equal(ch.statusCode, 200, ch.body);
  const c = ch.json();
  const res = await app.app.inject({
    method: 'POST', url: '/access/request', remoteAddress: freshIp(),
    payload: {
      challengeId: c.challengeId, nonce: c.nonce,
      signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)),
      fullName: 'Joana Pereira Lima', email: `joana.${address.slice(0, 6).toLowerCase()}@ex.test`,
      phone: '+55 11 95555-1000', country: 'BR', organization: 'Mesa Atlântico',
      referral: 'Rafael Monteiro', note: 'Quero abrir mesa de BTC contra USDT.',
      ...dados,
    },
  });
  return { res, address, kp, mensagem: c.message };
}

before(async () => { app = await buildApp({ env }); });
after(async () => { await app.app.close(); });

test('1. desligada, a rota não existe — e a mensagem assinada diz o que autoriza', async () => {
  const off = await buildApp({ env: { ...env, ACCESS_REQUESTS: 'off' }, seed: false });
  try {
    const r = await off.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address: demoAddress('pm01') } });
    assert.equal(r.statusCode, 404);                                           // nem 401: não existe
    assert.equal((await off.app.inject({ method: 'POST', url: '/access/request', payload: {} })).statusCode, 404);
    assert.equal((await off.app.inject({ method: 'GET', url: '/api/config' })).json().accessRequests, false);
  } finally { await off.app.close(); }

  assert.equal((await app.app.inject({ method: 'GET', url: '/api/config' })).json().accessRequests, true);
  const kp = nacl.sign.keyPair();
  const ch = await app.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address: base58Encode(kp.publicKey) }, remoteAddress: freshIp() });
  const msg = ch.json().message as string;
  assert.match(msg, /Prova de posse de carteira \(solicitação de acesso\)/);
  assert.match(msg, /Finalidade: Solicitar acesso à mesa privada/);
  assert.match(msg, /NÃO autoriza transação e NÃO movimenta fundos/);
});

test('2. solicitar NÃO cria conta: sem usuário, sem carteira, sem sessão', async () => {
  const { res, address } = await solicitar();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'PENDENTE');
  assert.equal(cookieOf(res, 'votc_session'), undefined);

  const { rows: u } = await app.db.query<any>(`SELECT 1 FROM users WHERE lower(email) LIKE 'joana.%@ex.test'`);
  assert.equal(u.length, 0, 'solicitação não pode criar usuário');
  const { rows: w } = await app.db.query<any>(`SELECT 1 FROM wallets WHERE address = $1`, [address]);
  assert.equal(w.length, 0, 'solicitação não pode registrar carteira');

  // E a carteira ainda não entra por login nenhum.
  const ch = await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c = ch.json();
  const login = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', remoteAddress: freshIp(), payload: { challengeId: c.challengeId, nonce: c.nonce, signature: 'A'.repeat(80) } });
  assert.ok([401, 403].includes(login.statusCode));
});

test('3. a carteira é comprovada: sem assinatura válida não há solicitação', async () => {
  const kp = nacl.sign.keyPair();
  const outra = nacl.sign.keyPair();
  const address = base58Encode(kp.publicKey);
  const ch = await app.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c = ch.json();
  const base = { fullName: 'Carlos Edu Mendes', email: 'carlos.falso@ex.test', phone: '+55 11 95555-2000', country: 'BR', organization: 'Mesa Teste' };

  // Assinatura de OUTRA carteira para o mesmo desafio.
  const falsa = await app.app.inject({ method: 'POST', url: '/access/request', remoteAddress: freshIp(),
    payload: { ...base, challengeId: c.challengeId, nonce: c.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), outra.secretKey)) } });
  assert.equal(falsa.statusCode, 401);
  // O desafio é de uso único: nem a assinatura certa vale depois.
  const certa = await app.app.inject({ method: 'POST', url: '/access/request', remoteAddress: freshIp(),
    payload: { ...base, challengeId: c.challengeId, nonce: c.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)) } });
  assert.equal(certa.statusCode, 401);
  assert.equal((await app.db.query<any>(`SELECT 1 FROM access_requests WHERE lower(email) = 'carlos.falso@ex.test'`)).rows.length, 0);
});

test('4. uma solicitação viva por carteira e por e-mail; dados inválidos recusados', async () => {
  const kp = nacl.sign.keyPair();
  const email = `dupla.${base58Encode(kp.publicKey).slice(0, 6).toLowerCase()}@ex.test`;
  assert.equal((await solicitar({ email }, kp)).res.statusCode, 200);
  // Mesma carteira de novo.
  const r2 = await solicitar({ email: 'outro.email@ex.test' }, kp);
  assert.equal(r2.res.statusCode, 409);
  assert.equal(r2.res.json().error, 'ALREADY_PENDING');
  // Mesmo e-mail, carteira diferente.
  const r3 = await solicitar({ email });
  assert.equal(r3.res.statusCode, 409);
  // Validação reaproveitada de validateSignup.
  const ruim = await solicitar({ fullName: 'X', email: 'nao-e-email', phone: '1', country: 'brasil' });
  assert.equal(ruim.res.statusCode, 400);
  // Organização é obrigatória — é o contexto que sustenta a decisão de aprovar.
  const semOrg = await solicitar({ organization: '' });
  assert.equal(semOrg.res.statusCode, 400);
  assert.match(semOrg.res.json().message, /organização/i);
});

test('5. quem já tem cadastro não solicita: entra', async () => {
  const r = await app.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address: demoAddress('pm01') }, remoteAddress: freshIp() });
  const c = r.json();
  const res = await app.app.inject({ method: 'POST', url: '/access/request', remoteAddress: freshIp(),
    payload: { challengeId: c.challengeId, nonce: c.nonce, signature: (await import('../src/demo.ts')).demoSign('pm01', c.message),
      fullName: 'Rafael Monteiro', email: 'rafael.outro@ex.test', phone: '+55 11 98811-4021', country: 'BR', organization: 'Verum' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'ALREADY_REGISTERED');
});

test('6. aprovar cria a conta; o aprovado entra, abre mesa e gera convite', async () => {
  const kp = nacl.sign.keyPair();
  const email = `primeiro.pm.${base58Encode(kp.publicKey).slice(0, 6).toLowerCase()}@ex.test`;
  const { res, address } = await solicitar({ fullName: 'Gabriel Souza Rocha', email, organization: 'Verum Mesa 01' }, kp);
  assert.equal(res.statusCode, 200);

  const { userId } = await access.approveRequest(app.ctx, email, 'operador de teste');
  const { rows: [u] } = await app.db.query<any>(`SELECT origin, is_demo, terms_accepted_at FROM users WHERE id = $1`, [userId]);
  assert.equal(u.origin, 'INVITE', 'aprovado por solicitação é parceiro pleno, não visualizador');
  assert.equal(u.is_demo, false);
  assert.ok(u.terms_accepted_at);
  const { rows: [w] } = await app.db.query<any>(`SELECT network, provider FROM wallets WHERE address = $1`, [address]);
  assert.equal(w.network, 'solana-demo');
  assert.equal(w.provider, 'verum-wallet');
  const { rows: [req] } = await app.db.query<any>(`SELECT status, user_id, decided_by FROM access_requests WHERE lower(email) = $1`, [email]);
  assert.equal(req.status, 'APROVADO');
  assert.equal(req.user_id, userId);
  assert.equal(req.decided_by, 'operador de teste');

  // Entra sozinho, pela carteira que provou na solicitação.
  const ch = await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c = ch.json();
  const login = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', remoteAddress: freshIp(),
    payload: { challengeId: c.challengeId, nonce: c.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)) } });
  assert.equal(login.statusCode, 200, login.body);
  const sessao = cookieOf(login, 'votc_session')!;

  // Abre a própria mesa...
  const mesa = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: sessao },
    payload: { kind: 'UNICA', title: 'Primeira mesa real', deliverAssetId: 'BTC:bitcoin-demo', receiveAssetId: 'USDT:solana-demo', volumeText: '10 BTC', grade: '7/4', roles: ['VENDEDOR', 'COMPRADOR'] } });
  assert.equal(mesa.statusCode, 200, mesa.body);
  // ...e gera o convite para os indicados. É a pergunta original respondida.
  const convite = await app.app.inject({ method: 'POST', url: '/invitations', headers: { cookie: sessao },
    payload: { dealId: mesa.json().dealId, roleKey: 'VENDEDOR', roleSeq: 1 } });
  assert.equal(convite.statusCode, 200, convite.body);
  assert.match(convite.json().link, /\/i\/[A-Za-z0-9_-]{43}$/);
  assert.match(convite.json().code, /^VOTC-[A-Z2-9]{6}$/);
});

test('7. recusar não cria nada, e decidida não se decide de novo', async () => {
  const kp = nacl.sign.keyPair();
  const email = `recusado.${base58Encode(kp.publicKey).slice(0, 6).toLowerCase()}@ex.test`;
  await solicitar({ email }, kp);
  await access.rejectRequest(app.ctx, email, 'operador de teste', 'Sem relação com a mesa.');

  const { rows: [r] } = await app.db.query<any>(`SELECT status, user_id, decision_note FROM access_requests WHERE lower(email) = $1`, [email]);
  assert.equal(r.status, 'RECUSADO');
  assert.equal(r.user_id, null);
  assert.equal(r.decision_note, 'Sem relação com a mesa.');
  assert.equal((await app.db.query<any>(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rows.length, 0);
  assert.equal((await app.db.query<any>(`SELECT 1 FROM wallets WHERE address = $1`, [base58Encode(kp.publicKey)])).rows.length, 0);

  await assert.rejects(access.approveRequest(app.ctx, email, 'x'), /já está RECUSADO/);
  await assert.rejects(access.rejectRequest(app.ctx, email, 'x', null), /já está RECUSADO/);
  // Depois de decidida, a pessoa pode solicitar de novo (os índices únicos são parciais).
  assert.equal((await solicitar({ email }, kp)).res.statusCode, 200);
});

test('9. e-mail: avisa a pessoa e o operador, e falha de envio NUNCA derruba a operação', async () => {
  const enviados: any[] = [];
  const mailBom = {
    enabled: true, remetente: 'VERUM NCNDA <suporte@verumcrypto.com>', operador: 'suporte@verumcrypto.com',
    async send(m: any) { enviados.push(m); return { ok: true, id: '1' }; },
    async verify() { return { ok: true }; },
  };
  const comEmail = await buildApp({ env, seed: false, mail: mailBom });
  try {
    const kp = nacl.sign.keyPair();
    const address = base58Encode(kp.publicKey);
    const ch = await comEmail.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
    const c = ch.json();
    const email = `aviso.${address.slice(0, 6).toLowerCase()}@ex.test`;
    const r = await comEmail.app.inject({
      method: 'POST', url: '/access/request', remoteAddress: freshIp(),
      payload: {
        challengeId: c.challengeId, nonce: c.nonce,
        signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)),
        fullName: 'Paula Antunes Reis', email, phone: '+55 11 95555-7000', country: 'BR', organization: 'Mesa Horizonte',
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().emailSent, true, 'a tela só afirma o envio quando ele é confirmado');
    assert.equal(enviados.length, 2, 'avisa quem pediu e quem decide');
    const paraPessoa = enviados.find((m) => m.para === email);
    assert.match(paraPessoa.assunto, /Recebemos sua solicitação/);
    assert.match(paraPessoa.texto, /solicitar não é cadastrar/);
    assert.ok(!paraPessoa.texto.includes('95555-7000'), 'o aviso não repete o telefone');
    const paraOperador = enviados.find((m) => m.para === 'suporte@verumcrypto.com');
    assert.match(paraOperador.texto, /npm run access -- approve/);
    assert.match(paraOperador.texto, new RegExp(address));

    // Aprovação avisa a pessoa com a carteira e o endereço de entrada.
    enviados.length = 0;
    const { envio } = await access.approveRequest(comEmail.ctx, email, 'operador');
    assert.equal(envio.ok, true);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].assunto, /aprovado/i);
    assert.match(enviados[0].texto, new RegExp(address));
    assert.match(enviados[0].texto, /MESMA carteira/);
  } finally { await comEmail.app.close(); }

  // SMTP fora do ar: a conta continua sendo criada e o comando recebe o motivo.
  const mailRuim = {
    enabled: true, remetente: 'x', operador: null,
    async send() { return { ok: false, motivo: 'ECONNREFUSED smtp.zoho.com:465' }; },
    async verify() { return { ok: false, motivo: 'ECONNREFUSED' }; },
  };
  const semRede = await buildApp({ env, seed: false, mail: mailRuim });
  try {
    const kp = nacl.sign.keyPair();
    const address = base58Encode(kp.publicKey);
    const ch = await semRede.app.inject({ method: 'POST', url: '/access/request/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
    const c = ch.json();
    const email = `semrede.${address.slice(0, 6).toLowerCase()}@ex.test`;
    const r = await semRede.app.inject({
      method: 'POST', url: '/access/request', remoteAddress: freshIp(),
      payload: {
        challengeId: c.challengeId, nonce: c.nonce,
        signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)),
        fullName: 'Rogerio Mantovani', email, phone: '+55 11 95555-7001', country: 'BR', organization: 'Mesa Sul',
      },
    });
    assert.equal(r.statusCode, 200, 'e-mail quebrado não pode derrubar a solicitação');
    assert.equal(r.json().emailSent, false, 'e sem mentir que avisou');
    const { userId, envio } = await access.approveRequest(semRede.ctx, email, 'operador');
    assert.ok(userId, 'a conta é criada mesmo sem e-mail');
    assert.equal(envio.ok, false);
    assert.match(envio.motivo!, /ECONNREFUSED/);
    const { rows } = await semRede.db.query<any>(`SELECT status FROM access_requests WHERE lower(email) = $1`, [email]);
    assert.equal(rows[0].status, 'APROVADO');
  } finally { await semRede.app.close(); }
});

test('9b. SMTP pendurado não segura a resposta: o teto corta e a solicitação continua de pé', async () => {
  // Serverless congela a função ao responder, então o envio é aguardado — mas com teto, senão um
  // SMTP que não responde deixaria a pessoa olhando a tela até o timeout do socket.
  const pendurado = {
    enabled: true, remetente: 'x', operador: null,
    send: () => new Promise<any>(() => {}),                                    // nunca resolve
    async verify() { return { ok: true }; },
  };
  const { enviarComLimite } = await import('../src/services/mailer.ts');
  const t0 = Date.now();
  const r = await enviarComLimite(pendurado as any, { para: 'a@b.test', assunto: 'x', texto: 'y' }, 300);
  const levou = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.motivo!, /sem resposta do servidor de e-mail/);
  assert.ok(levou < 2000, `o teto tem de cortar rápido (levou ${levou}ms)`);

  // E um envio que explode também não vaza exceção.
  const explode = { enabled: true, remetente: 'x', operador: null, async send() { throw new Error('boom'); }, async verify() { return { ok: true }; } };
  const r2 = await enviarComLimite(explode as any, { para: 'a@b.test', assunto: 'x', texto: 'y' }, 300);
  assert.equal(r2.ok, false);
  assert.match(r2.motivo!, /boom/);
});

test('10. sem SMTP configurado o envio fica desligado e a interface não promete e-mail', async () => {
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/config' })).json().emailEnabled, false);
  assert.equal(app.ctx.mail.enabled, false);
  const r = await app.ctx.mail.send({ para: 'x@ex.test', assunto: 'a', texto: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.motivo!, /desligado/i);
});

test('8. a auditoria registra pedido e decisão, sem dado pessoal', async () => {
  const { rows } = await app.db.query<any>(
    `SELECT action, row_to_json(a)::text AS j FROM audit_logs a WHERE action LIKE 'ACCESS_%'`);
  const acoes = new Set(rows.map((r) => r.action));
  for (const a of ['ACCESS_REQUESTED', 'ACCESS_APPROVED', 'ACCESS_REJECTED']) assert.ok(acoes.has(a), a);
  const blob = rows.map((r) => r.j).join('\n');
  assert.doesNotMatch(blob, /@ex\.test/);
  assert.doesNotMatch(blob, /Gabriel Souza Rocha|Joana Pereira Lima/);
});

test('11. embarque na Verum Wallet: iframe e cookies mudam juntos, e só quando EMBED_ORIGINS manda', async () => {
  // Fechado (padrão de hoje): ninguém enquadra a mesa e o cookie é Strict.
  const fechado = await app.app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(fechado.headers['x-frame-options'], 'DENY');
  assert.match(fechado.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  // Fechado, o conector recebe lista vazia — e não há a quem mandar nada, porque ninguém enquadra.
  const semOrigens = await app.app.inject({ method: 'GET', url: '/verum-origins.js' });
  assert.equal(semOrigens.statusCode, 200);
  assert.match(semOrigens.body, /window\.__VERUM_WALLET_ORIGINS__ = \[\];/);

  const WALLET = 'https://verumcrypto.com';
  // seed padrão: precisa da persona pm01 para o login devolver cookie de sessão.
  const aberto = await buildApp({ env: { ...env, EMBED_ORIGINS: WALLET, COOKIE_SECURE: 'true' } });
  try {
    const r = await aberto.app.inject({ method: 'GET', url: '/api/config' });
    // X-Frame-Options não tem lista de origens: com embarque ligado ele some e quem decide é a CSP.
    assert.equal(r.headers['x-frame-options'], undefined);
    assert.match(r.headers['content-security-policy'] as string, new RegExp(`frame-ancestors ${WALLET}`));
    assert.doesNotMatch(r.headers['content-security-policy'] as string, /frame-ancestors 'none'/);

    // A lista que o conector usa como targetOrigin tem de ser a MESMA de frame-ancestors: lista
    // vazia o faria mandar a mensagem a assinar para '*', ou seja, para qualquer pai.
    const origens = await aberto.app.inject({ method: 'GET', url: '/verum-origins.js' });
    assert.match(String(origens.headers['content-type']), /javascript/);
    assert.equal(origens.body.match(/__VERUM_WALLET_ORIGINS__ = (\[.*\]);/)?.[1], JSON.stringify([WALLET]));
    assert.match(String(origens.headers['cache-control']), /no-store/, 'a lista muda com a variável, sem rebuild');

    // O cookie precisa viajar em iframe de outro domínio: Strict nem seria enviado.
    const ch = await aberto.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address: demoAddress('pm01') }, remoteAddress: freshIp() });
    const c = ch.json();
    const login = await aberto.app.inject({ method: 'POST', url: '/auth/wallet-verify', remoteAddress: freshIp(), payload: { challengeId: c.challengeId, nonce: c.nonce, signature: (await import('../src/demo.ts')).demoSign('pm01', c.message) } });
    const cookie = String(login.headers['set-cookie']);
    assert.match(cookie, /SameSite=None/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /Partitioned/i, 'CHIPS: o cookie fica preso ao par wallet↔mesa');
  } finally { await aberto.app.close(); }

  // SameSite=None sem Secure seria descartado pelo navegador: falha silenciosa, recusada no boot.
  await assert.rejects(
    buildApp({ env: { ...env, EMBED_ORIGINS: WALLET, COOKIE_SECURE: 'false' }, seed: false }),
    /EMBED_ORIGINS exige COOKIE_SECURE=true/);
  // Origem malformada também não passa: enquadrar é autorização, não palpite.
  await assert.rejects(
    buildApp({ env: { ...env, EMBED_ORIGINS: 'verumcrypto.com', COOKIE_SECURE: 'true' }, seed: false }),
    /EMBED_ORIGINS aceita origens https/);
});
