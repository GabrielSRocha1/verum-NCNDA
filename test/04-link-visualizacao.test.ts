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

test('7. a auditoria registra geração, troca e acesso — sem token em claro', async () => {
  const { id } = await linkDe('OTC-0001');
  const { rows } = await app.db.query<any>(
    `SELECT action, row_to_json(a)::text AS j FROM audit_logs a WHERE deal_id = $1 AND action LIKE 'VIEW_LINK_%'`, [id]);
  const acoes = new Set(rows.map((r) => r.action));
  for (const a of ['VIEW_LINK_CREATED', 'VIEW_LINK_ACCESSED']) assert.ok(acoes.has(a), a);
  const { rows: [{ view_token: token }] } = await app.db.query<any>(`SELECT view_token FROM deals WHERE id = $1`, [id]);
  assert.ok(!rows.map((r) => r.j).join('\n').includes(token));
});
