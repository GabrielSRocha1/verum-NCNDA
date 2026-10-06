// Link de visualização da mesa: um por mesa, só leitura, do admin. O que estes testes travam:
// quem gera, o que o link revela antes da identificação, e que visualizador NÃO age.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { base58Encode } from '../src/lib/crypto.ts';
import { demoAddress, demoSign } from '../src/demo.ts';

const env = { DATA_DIR: 'memory', DEMO_MODE: 'true', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: 'http://localhost:8787' } as any;
let app: BuiltApp;
let ipCounter = 0;
const freshIp = () => `10.4.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function cookieOf(res: any, name: string): string | undefined {
  const raw = res.headers['set-cookie']; const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x: string) => x.startsWith(name + '='));
  return c ? c.split(';')[0] : undefined;
}
async function loginAs(personaKey: string) {
  const address = demoAddress(personaKey);
  const ch = await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c = ch.json();
  const v = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', payload: { challengeId: c.challengeId, nonce: c.nonce, signature: demoSign(personaKey, c.message) }, remoteAddress: freshIp() });
  assert.equal(v.statusCode, 200, v.body);
  return cookieOf(v, 'votc_session')!;
}
const dealId = async (code: string) => (await app.db.query<any>(`SELECT id FROM deals WHERE code = $1`, [code])).rows[0].id as string;
const get = (url: string, cookie?: string) => app.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const post = (url: string, cookie?: string, payload?: any) => app.app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload: payload ?? {} });

/** Gera o link da OTC-0002 (mesa travada, 7 participantes) e devolve token + cookie do admin. */
async function linkDe(code = 'OTC-0002') {
  const admin = await loginAs('pm01');
  const id = await dealId(code);
  const r = await post(`/api/deals/${id}/share-link`, admin);
  assert.equal(r.statusCode, 200, r.body);
  return { admin, id, ...r.json() as { token: string; url: string } };
}

before(async () => { app = await buildApp({ env }); });
after(async () => { await app.app.close(); });

test('1. só o admin gera o link; o mesmo link é reexibido e o token sai do formato esperado', async () => {
  const { admin, id, token, url } = await linkDe();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url, `http://localhost:8787/#/m/${token}`);
  // Reexibir devolve o MESMO link: o admin precisa poder recompartilhar o que já enviou.
  assert.equal((await get(`/api/deals/${id}/share-link`, admin)).json().token, token);
  assert.equal((await post(`/api/deals/${id}/share-link`, admin)).json().token, token);
  // Participante da mesa não gera nem enxerga o link.
  const parceiro = await loginAs('comp');
  assert.equal((await get(`/api/deals/${id}/share-link`, parceiro)).statusCode, 403);
  assert.equal((await post(`/api/deals/${id}/share-link`, parceiro)).statusCode, 403);
  assert.equal((await post(`/api/deals/${id}/share-link/regenerate`, parceiro)).statusCode, 403);
  assert.equal((await get(`/api/deals/${id}/viewers`, parceiro)).statusCode, 403);
  // Sem sessão não há nada.
  assert.equal((await get(`/api/deals/${id}/share-link`)).statusCode, 401);
});

test('2. o portão não revela a operação antes da identificação', async () => {
  const { token } = await linkDe();
  const forasteiro = await loginAs('pm02');                                   // tem conta, não é desta mesa
  const gate = await get(`/api/shared/${token}/gate`, forasteiro);
  assert.equal(gate.statusCode, 200, gate.body);
  const g = gate.json();
  assert.equal(g.registered, false);
  assert.equal(g.deal.code, 'OTC-0002');
  // Só o cabeçalho. O prefill traz os dados de QUEM está abrindo (para ele não redigitar),
  // então o que não pode aparecer é a operação: participantes, linhas, percentuais, e nenhum
  // contato de terceiro.
  const corpo = gate.body;
  assert.doesNotMatch(corpo, /participants|"lines"|bps|grade|conditions|signatures/);
  assert.doesNotMatch(corpo, /rafael\.monteiro|marcos\.albuquerque|@demo\.verum".*@demo\.verum/);
  assert.equal(g.prefill.email, 'helena.duarte@demo.verum');                  // só o dele mesmo
  // E a mesa em si continua fechada enquanto não se identificar.
  const antes = await get(`/api/shared/${token}`, forasteiro);
  assert.equal(antes.statusCode, 403);
  assert.equal(antes.json().error, 'VIEWER_REGISTRATION_REQUIRED');
});

test('3. identificado, vê a operação inteira em modo leitura — sem "eu", sem admin, sem contatos', async () => {
  const { token } = await linkDe();
  const forasteiro = await loginAs('pm02');
  const reg = await post(`/api/shared/${token}/register`, forasteiro, { fullName: 'Helena Duarte', email: 'helena.viewer@ex.test', phone: '+595 981 552-310', country: 'PY' });
  assert.equal(reg.statusCode, 200, reg.body);
  assert.equal((await get(`/api/shared/${token}/gate`, forasteiro)).json().registered, true);

  const r = await get(`/api/shared/${token}`, forasteiro);
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.readOnly, true);
  assert.equal(d.sharedToken, token);
  assert.equal(d.isAdmin, false);
  assert.equal(d.me, null);
  assert.equal(d.code, 'OTC-0002');
  assert.equal(d.participants.length, 7);
  // Vê a estrutura comercial (é o ponto do link), mas nenhum participante é "eu" e nenhum contato vaza.
  assert.ok(d.lines.length > 0);
  assert.ok(d.participants.every((p: any) => p.isMe === false));
  assert.ok(d.participants.every((p: any) => p.email === null && p.phone === null));
  assert.ok(d.participants.every((p: any) => p.invite === null));
  // As sub-rotas de leitura também respondem.
  for (const sub of ['history', 'compliance', 'documents', 'settlement/preview']) {
    assert.equal((await get(`/api/shared/${token}/${sub}`, forasteiro)).statusCode, 200, sub);
  }
  // Baixar documento faz parte de ver a operação: a OTC-0002 não tem documento no seed, então
  // basta provar que a rota existe e recusa um id inexistente como "não encontrado", não como 404
  // de rota ausente (que deixaria o botão BAIXAR quebrado para quem abre o link).
  const baixa = await get(`/api/shared/${token}/documents/00000000-0000-4000-8000-000000000000/content`, forasteiro);
  assert.equal(baixa.statusCode, 404);
  assert.equal(baixa.json().error, 'NOT_FOUND');
  assert.match(baixa.json().message, /Documento não encontrado/);
});

test('4. visualizador não age: nenhuma rota de escrita aceita o token, e as da mesa continuam fechadas', async () => {
  const { id, token } = await linkDe();
  const forasteiro = await loginAs('pm02');                                   // já identificado no teste 3
  // Não existe rota de escrita sob /api/shared: o roteador responde 404 para qualquer tentativa.
  for (const alvo of ['submit', 'agreement/sign', 'documents', 'slots']) {
    assert.equal((await post(`/api/shared/${token}/${alvo}`, forasteiro)).statusCode, 404, alvo);
  }
  // E identificar-se não dá acesso à mesa pelo id: continua fora, como qualquer desconhecido.
  assert.equal((await get(`/api/deals/${id}`, forasteiro)).statusCode, 404);
  assert.equal((await get(`/api/deals/${id}/history`, forasteiro)).statusCode, 404);
  assert.equal((await get(`/api/deals/${id}/viewers`, forasteiro)).statusCode, 403);
  // Rota exclusiva do admin responde 403 (assertDealAdmin), não 404 — comportamento que já existia.
  assert.equal((await post(`/api/deals/${id}/submit`, forasteiro)).statusCode, 403);
  // Nem vira participante da operação.
  const { rows } = await app.db.query<any>(`SELECT 1 FROM deal_participants WHERE deal_id = $1 AND user_id = (SELECT user_id FROM wallets WHERE address = $2)`, [id, demoAddress('pm02')]);
  assert.equal(rows.length, 0);
});

test('5. regenerar troca o token e o anterior para de valer na hora', async () => {
  const { admin, id, token } = await linkDe('OTC-0003');
  const forasteiro = await loginAs('comp');
  await post(`/api/shared/${token}/register`, forasteiro, { fullName: 'Beatriz Lacerda', email: 'bia.viewer@ex.test', phone: '+1 305 555-0144', country: 'US' });
  assert.equal((await get(`/api/shared/${token}`, forasteiro)).statusCode, 200);

  const novo = (await post(`/api/deals/${id}/share-link/regenerate`, admin)).json();
  assert.notEqual(novo.token, token);
  assert.equal((await get(`/api/shared/${token}`, forasteiro)).statusCode, 404);        // o anterior morreu
  assert.equal((await get(`/api/shared/${novo.token}`, forasteiro)).statusCode, 200);   // quem já se identificou segue
  // Token inventado nunca vira acesso.
  assert.equal((await get(`/api/shared/${'A'.repeat(43)}`, forasteiro)).statusCode, 404);
  assert.equal((await get('/api/shared/token-curto', forasteiro)).statusCode, 400);
});

test('6. o admin vê quem se identificou, com o que a pessoa declarou e a carteira que assinou', async () => {
  const { admin, id, token } = await linkDe('OTC-0001');
  const kp = nacl.sign.keyPair();                                            // carteira sem cadastro
  const address = base58Encode(kp.publicKey);
  const ch = await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c = ch.json();
  const v = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', remoteAddress: freshIp(), payload: { challengeId: c.challengeId, nonce: c.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)) } });
  // Sem cadastro público: carteira desconhecida não entra nem com o link na mão.
  assert.equal(v.statusCode, 403);
  assert.equal(v.json().error, 'WALLET_NOT_REGISTERED');

  const vend = await loginAs('vend');
  await post(`/api/shared/${token}/register`, vend, { fullName: 'Marcos Albuquerque', email: 'marcos.viewer@ex.test', phone: '+55 21 99702-1188', country: 'BR' });
  const lista = await get(`/api/deals/${id}/viewers`, admin);
  assert.equal(lista.statusCode, 200, lista.body);
  const out = lista.json();
  assert.equal(out.hasLink, true);
  assert.equal(out.viewers.length, 1);
  assert.equal(out.viewers[0].name, 'Marcos Albuquerque');
  assert.equal(out.viewers[0].email, 'marcos.viewer@ex.test');
  assert.equal(out.viewers[0].countryLabel, 'Brasil');
  assert.equal(out.viewers[0].wallet, demoAddress('vend'));
  assert.equal(out.viewers[0].isParticipant, true);                          // é parceiro desta mesa
  // Identificar-se duas vezes na mesma mesa é recusado.
  const dup = await post(`/api/shared/${token}/register`, vend, { fullName: 'Marcos Albuquerque', email: 'marcos.viewer@ex.test', phone: '+55 21 99702-1188', country: 'BR' });
  assert.equal(dup.statusCode, 409);
  // Dados inválidos não entram.
  const comp = await loginAs('comp');
  const ruim = await post(`/api/shared/${token}/register`, comp, { fullName: 'X', email: 'nao-e-email', phone: '1', country: 'brasil' });
  assert.equal(ruim.statusCode, 400);
});

/** Prova a carteira pelo link e devolve os cookies (sessão ou prova da carteira). */
async function provarCarteira(token: string, kp: nacl.SignKeyPair) {
  const address = base58Encode(kp.publicKey);
  const ch = await app.app.inject({ method: 'POST', url: `/api/shared/${token}/wallet-challenge`, payload: { address }, remoteAddress: freshIp() });
  assert.equal(ch.statusCode, 200, ch.body);
  const c = ch.json();
  const v = await app.app.inject({
    method: 'POST', url: `/api/shared/${token}/wallet-verify`, remoteAddress: freshIp(),
    payload: { challengeId: c.challengeId, nonce: c.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey)) },
  });
  assert.equal(v.statusCode, 200, v.body);
  return { address, step: v.json().step as string, prova: cookieOf(v, 'votc_view'), sessao: cookieOf(v, 'votc_session') };
}

test('8. carteira SEM cadastro entra pelo link: prova a carteira, se identifica e lê a operação', async () => {
  const { token } = await linkDe('OTC-0002');
  const kp = nacl.sign.keyPair();
  const { address, step, prova, sessao } = await provarCarteira(token, kp);
  assert.equal(step, 'SIGNUP');
  assert.equal(sessao, undefined);                                            // ainda não há sessão
  assert.ok(prova, 'a carteira provada precisa ficar guardada até o cadastro terminar');

  // Com a carteira provada, o portão abre — mas sem nada da operação e sem prefill.
  const gate = await app.app.inject({ method: 'GET', url: `/api/shared/${token}/gate`, headers: { cookie: prova! } });
  assert.equal(gate.statusCode, 200, gate.body);
  assert.equal(gate.json().registered, false);
  assert.equal(gate.json().prefill, null);
  assert.equal(gate.json().deal.code, 'OTC-0002');

  const reg = await app.app.inject({ method: 'POST', url: `/api/shared/${token}/register`, headers: { cookie: prova! },
    payload: { fullName: 'Tereza Vilanova', email: 'tereza.nova@ex.test', phone: '+55 11 93333-0001', country: 'BR' } });
  assert.equal(reg.statusCode, 200, reg.body);
  const sessaoNova = cookieOf(reg, 'votc_session');
  assert.ok(sessaoNova, 'concluir a identificação entra na sessão');

  const d = await app.app.inject({ method: 'GET', url: `/api/shared/${token}`, headers: { cookie: sessaoNova! } });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().readOnly, true);
  assert.equal(d.json().participants.length, 7);
  // A conta existe e é dela, com a carteira que assinou.
  const me = await app.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sessaoNova! } });
  assert.equal(me.json().fullName, 'Tereza Vilanova');
  assert.equal(me.json().wallet, address);
  // E agora entra por login normal, como qualquer cadastro.
  const ch2 = await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() });
  const c2 = ch2.json();
  const login = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', remoteAddress: freshIp(), payload: { challengeId: c2.challengeId, nonce: c2.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(c2.message), kp.secretKey)) } });
  assert.equal(login.statusCode, 200);
});

test('9. o cadastro por link é SÓ de visualizador: não pertence a mesa, não abre mesa própria', async () => {
  const { token } = await linkDe('OTC-0003');
  const kp = nacl.sign.keyPair();
  const { prova } = await provarCarteira(token, kp);
  const reg = await app.app.inject({ method: 'POST', url: `/api/shared/${token}/register`, headers: { cookie: prova! },
    payload: { fullName: 'Otavio Brandao', email: 'otavio.visual@ex.test', phone: '+55 11 93333-0002', country: 'BR' } });
  const sessao = cookieOf(reg, 'votc_session')!;
  // Não é membro de nada: a lista de mesas vem vazia e o dashboard não mostra operação alheia.
  assert.deepEqual((await get('/api/deals', sessao)).json().deals, []);
  assert.equal((await get(`/api/deals/${await dealId('OTC-0003')}`, sessao)).statusCode, 404);
  // E não cria mesa própria: leitura compartilhada não é lugar na plataforma.
  const tentativa = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: sessao },
    payload: { kind: 'UNICA', title: 'Mesa do visualizador', deliverAssetId: 'USDT:solana-demo', receiveAssetId: 'USD:cash', volumeText: '1', grade: '5/3' } });
  assert.equal(tentativa.statusCode, 403);
  assert.equal(tentativa.json().error, 'VIEWER_ONLY');
});

test('10. sem link válido não há cadastro: o token é a autorização', async () => {
  const kp = nacl.sign.keyPair();
  const address = base58Encode(kp.publicKey);
  for (const t of ['A'.repeat(43), 'curto']) {
    const r = await app.app.inject({ method: 'POST', url: `/api/shared/${t}/wallet-challenge`, payload: { address }, remoteAddress: freshIp() });
    assert.ok([400, 404].includes(r.statusCode), `${t} → ${r.statusCode}`);
  }
  // Identificar-se sem sessão e sem carteira provada é recusado.
  const { token } = await linkDe('OTC-0002');
  const semProva = await app.app.inject({ method: 'POST', url: `/api/shared/${token}/register`, payload: { fullName: 'Ninguem Sem Prova', email: 'sem.prova@ex.test', phone: '+55 11 93333-0003', country: 'BR' } });
  assert.equal(semProva.statusCode, 401);
  // A prova vale só para o link em que foi feita.
  const outro = await linkDe('OTC-0001');
  const { prova } = await provarCarteira(outro.token, kp);
  const trocado = await app.app.inject({ method: 'POST', url: `/api/shared/${token}/register`, headers: { cookie: prova! },
    payload: { fullName: 'Carteira Trocada', email: 'trocada@ex.test', phone: '+55 11 93333-0004', country: 'BR' } });
  assert.equal(trocado.statusCode, 401);
  // E-mail já usado por outra carteira não vira segundo cadastro.
  const kp2 = nacl.sign.keyPair();
  const p2 = await provarCarteira(outro.token, kp2);
  const dup = await app.app.inject({ method: 'POST', url: `/api/shared/${outro.token}/register`, headers: { cookie: p2.prova! },
    payload: { fullName: 'Email Repetido', email: 'rafael.monteiro@demo.verum', phone: '+55 11 93333-0005', country: 'BR' } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error, 'EMAIL_IN_USE');
});

test('11. concluir um convite promove a conta de visualizador para parceiro', async () => {
  const { token } = await linkDe('OTC-0002');
  const kp = nacl.sign.keyPair();
  const { address, prova } = await provarCarteira(token, kp);
  await app.app.inject({ method: 'POST', url: `/api/shared/${token}/register`, headers: { cookie: prova! },
    payload: { fullName: 'Renata Colosso', email: 'renata.promo@ex.test', phone: '+55 11 93333-0006', country: 'BR' } });
  const { rows: [antes] } = await app.db.query<any>(`SELECT origin FROM users WHERE lower(email) = 'renata.promo@ex.test'`);
  assert.equal(antes.origin, 'VIEW_LINK');

  // Admin convida essa carteira para a cadeira vazia da OTC-0001 e ela conclui o convite.
  const admin = await loginAs('pm01');
  const id1 = await dealId('OTC-0001');
  const inv = await app.app.inject({ method: 'POST', url: '/invitations', headers: { cookie: admin }, payload: { dealId: id1, roleKey: 'INTERMEDIACAO_COMPRA', roleSeq: 1 } });
  assert.equal(inv.statusCode, 200, inv.body);
  const t = (inv.json().link as string).split('/i/')[1];
  const o = await app.app.inject({ method: 'POST', url: '/invite/open', payload: { token: t }, remoteAddress: freshIp() });
  const ck = cookieOf(o, 'votc_inv')!;
  await app.app.inject({ method: 'POST', url: '/invite/verify-code', payload: { token: t, code: inv.json().code }, headers: { cookie: ck }, remoteAddress: freshIp() });
  const wch = await app.app.inject({ method: 'POST', url: '/invite/wallet-challenge', payload: { token: t, address }, headers: { cookie: ck }, remoteAddress: freshIp() });
  const w = wch.json();
  const wv = await app.app.inject({ method: 'POST', url: '/invite/wallet-verify', headers: { cookie: ck }, remoteAddress: freshIp(),
    payload: { token: t, challengeId: w.challengeId, nonce: w.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(w.message), kp.secretKey)) } });
  assert.equal(wv.json().step, 'TERMS');                                       // já tem cadastro
  const fim = await app.app.inject({ method: 'POST', url: '/invite/complete', payload: { token: t, acceptTerms: true }, headers: { cookie: ck }, remoteAddress: freshIp() });
  assert.equal(fim.statusCode, 200, fim.body);

  const { rows: [depois] } = await app.db.query<any>(`SELECT origin FROM users WHERE lower(email) = 'renata.promo@ex.test'`);
  assert.equal(depois.origin, 'INVITE');
  // E agora pode abrir mesa própria.
  const sessao = cookieOf(fim, 'votc_session')!;
  const criar = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: sessao },
    payload: { kind: 'UNICA', title: 'Mesa de quem virou parceiro', deliverAssetId: 'USDT:solana-demo', receiveAssetId: 'USD:cash', volumeText: '1', grade: '5/3' } });
  assert.equal(criar.statusCode, 200, criar.body);
});

test('7. a auditoria registra geração, troca e acesso — sem token em claro', async () => {
  const { id } = await linkDe('OTC-0001');
  const { rows } = await app.db.query<any>(
    `SELECT action, row_to_json(a)::text AS j FROM audit_logs a WHERE deal_id = $1 AND action LIKE 'VIEW_LINK_%'`, [id]);
  const acoes = new Set(rows.map((r) => r.action));
  for (const a of ['VIEW_LINK_CREATED', 'VIEW_LINK_ACCESSED']) assert.ok(acoes.has(a), a);
  const { rows: [{ view_token: token }] } = await app.db.query<any>(`SELECT view_token FROM deals WHERE id = $1`, [id]);
  assert.ok(!rows.map((r) => r.j).join('\n').includes(token));
});
