// Seção 3.9 — 20 testes obrigatórios do convite de acesso único e onboarding.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { base58Encode } from '../src/lib/crypto.ts';
import { demoAddress, demoSign, PERSONAS } from '../src/demo.ts';

let clock = new Date('2026-10-05T12:00:00Z');
const env = { DATA_DIR: 'memory', DEMO_MODE: 'true', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: 'http://localhost:8787' } as any;
let app: BuiltApp;
let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
const GENERIC = 'Este convite não é mais válido. Peça um novo link.';

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
async function demo1() {
  const { rows: [d] } = await app.db.query<any>(`SELECT id FROM deals WHERE code = 'OTC-0001'`);
  return d.id as string;
}
async function createInvite(admin: string, roleKey = 'INTERMEDIACAO_COMPRA', dealId?: string, roleSeq = 1) {
  const r = await app.app.inject({ method: 'POST', url: '/invitations', headers: { cookie: admin }, payload: { dealId: dealId ?? await demo1(), roleKey, roleSeq } });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  return { ...j, token: j.link.split('/i/')[1] as string };
}
const open = (token: string, ip = freshIp()) => app.app.inject({ method: 'POST', url: '/invite/open', payload: { token }, remoteAddress: ip });
const stepCall = (url: string, token: string, cookie: string | undefined, extra: Record<string, unknown> = {}, ip = freshIp()) =>
  app.app.inject({ method: 'POST', url, payload: { token, ...extra }, headers: cookie ? { cookie } : {}, remoteAddress: ip });

/** Convite aberto + código verificado, devolvendo o cookie do navegador. */
async function openAndVerify(admin: string, roleKey = 'INTERMEDIACAO_COMPRA', dealId?: string, roleSeq = 1) {
  const inv = await createInvite(admin, roleKey, dealId, roleSeq);
  const o = await open(inv.token); assert.equal(o.statusCode, 200);
  const cookie = cookieOf(o, 'votc_inv')!;
  const v = await stepCall('/invite/verify-code', inv.token, cookie, { code: inv.code }); assert.equal(v.statusCode, 200, v.body);
  return { inv, cookie, summary: v.json().summary };
}
async function walletProve(token: string, cookie: string, kp: nacl.SignKeyPair) {
  const address = base58Encode(kp.publicKey);
  const ch = await stepCall('/invite/wallet-challenge', token, cookie, { address }); assert.equal(ch.statusCode, 200, ch.body);
  const c = ch.json();
  const signature = base58Encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey));
  return stepCall('/invite/wallet-verify', token, cookie, { challengeId: c.challengeId, nonce: c.nonce, signature });
}

before(async () => { app = await buildApp({ env, config: { now: () => clock } }); });
after(async () => { await app.app.close(); });

test('1. gerar convite devolve link e código; o banco guarda apenas hashes', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  assert.match(inv.link, /\/i\/[A-Za-z0-9_-]{43}$/); assert.match(inv.code, /^VOTC-[A-Z2-9]{6}$/);
  assert.match(inv.message, /uso único/);
  const { rows: [row] } = await app.db.query<any>(`SELECT token_hash, code_hash FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/); assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  const { rows: all } = await app.db.query<any>(`SELECT row_to_json(i)::text AS j FROM invitations i WHERE id = $1`, [inv.invitation.id]);
  assert.ok(!all[0].j.includes(inv.token) && !all[0].j.includes(inv.code));
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('2. GET e HEAD do link (inclusive robô de prévia) não consomem e não revelam dados', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  for (const method of ['GET', 'HEAD'] as const) {
    const r = await app.app.inject({ method, url: `/i/${inv.token}`, headers: { 'user-agent': 'WhatsApp/2.23.20 facebookexternalhit/1.1 Twitterbot' } });
    assert.equal(r.statusCode, 200); assert.match(r.headers['cache-control'] as string, /no-store/); assert.match(r.headers['x-robots-tag'] as string, /noindex/);
    if (method === 'GET') { assert.ok(!r.body.includes('OTC-0001') && !r.body.includes('Intermedia') && !r.body.includes('Rafael')); assert.match(r.body, /Convite privado VERUM NCNDA/); }
  }
  const { rows: [row] } = await app.db.query<any>(`SELECT status FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(row.status, 'ATIVO');
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('3. POST /invite/open consome (ATIVO → ABERTO); outro navegador não abre', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  const o = await open(inv.token); assert.equal(o.statusCode, 200); assert.ok(cookieOf(o, 'votc_inv'));
  assert.deepEqual(Object.keys(o.json()).sort(), ['step', 'walletDownloadUrl']);
  const { rows: [row] } = await app.db.query<any>(`SELECT status, opened_session_hash FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(row.status, 'ABERTO'); assert.match(row.opened_session_hash, /^[0-9a-f]{64}$/);
  const o2 = await open(inv.token); assert.equal(o2.statusCode, 404); assert.equal(o2.json().message, GENERIC);
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('4. mesmo navegador retoma dentro da janela; fora dela falha; janela 0 nunca retoma', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  const t0 = clock;
  const o = await open(inv.token); const cookie = cookieOf(o, 'votc_inv')!;
  assert.equal((await stepCall('/invite/resume', inv.token, cookie)).statusCode, 200);
  assert.equal((await stepCall('/invite/resume', inv.token, undefined)).statusCode, 404);           // navegador sem cookie
  clock = new Date(t0.getTime() + 9 * 60_000);
  assert.equal((await stepCall('/invite/resume', inv.token, cookie)).statusCode, 200);
  clock = new Date(t0.getTime() + 10 * 60_000 + 1000);
  assert.equal((await stepCall('/invite/resume', inv.token, cookie)).statusCode, 404);
  clock = t0;
  const strict = await buildApp({ env: { ...env, RESUME_WINDOW_MINUTES: '0' }, config: { now: () => clock }, seed: true });
  try {
    const a2 = await (async () => { const address = demoAddress('pm01'); const ch = await strict.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address } }); const c = ch.json(); const v = await strict.app.inject({ method: 'POST', url: '/auth/wallet-verify', payload: { challengeId: c.challengeId, nonce: c.nonce, signature: demoSign('pm01', c.message) } }); return cookieOf(v, 'votc_session')!; })();
    const { rows: [d] } = await strict.db.query<any>(`SELECT id FROM deals WHERE code = 'OTC-0001'`);
    const r = await strict.app.inject({ method: 'POST', url: '/invitations', headers: { cookie: a2 }, payload: { dealId: d.id, roleKey: 'INTERMEDIACAO_COMPRA' } });
    const tok = r.json().link.split('/i/')[1];
    const so = await strict.app.inject({ method: 'POST', url: '/invite/open', payload: { token: tok } });
    const sc = cookieOf(so, 'votc_inv')!;
    const rs = await strict.app.inject({ method: 'POST', url: '/invite/resume', payload: { token: tok }, headers: { cookie: sc } });
    assert.equal(rs.statusCode, 404);                                                                  // uso único estrito
    const vc = await strict.app.inject({ method: 'POST', url: '/invite/verify-code', payload: { token: tok, code: r.json().code }, headers: { cookie: sc } });
    assert.equal(vc.statusCode, 200);                                                                  // mas a etapa em curso continua
  } finally { await strict.app.close(); }
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('5. convite ABERTO não concluído vira EXPIRADO ao fim da janela e nunca volta a ATIVO', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  const t0 = clock;
  await open(inv.token);
  clock = new Date(t0.getTime() + 11 * 60_000);
  await app.app.inject({ method: 'GET', url: '/invitations', headers: { cookie: admin } });              // varredura
  const { rows: [row] } = await app.db.query<any>(`SELECT status FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(row.status, 'EXPIRADO');
  await assert.rejects(app.db.query(`UPDATE invitations SET status = 'ATIVO' WHERE id = $1`, [inv.invitation.id]), /INVITE_TERMINAL|INVITE_CANNOT_RETURN/);
  const { rows: [ev] } = await app.db.query<any>(`SELECT 1 FROM audit_logs WHERE action = 'INVITE_EXPIRED' AND entity_id = $1`, [inv.invitation.id]);
  assert.ok(ev);
  clock = t0;
  // Convite ATIVO vencido também expira
  const inv2 = await createInvite(admin);
  clock = new Date(t0.getTime() + 25 * 3600_000);
  assert.equal((await open(inv2.token)).statusCode, 404);
  clock = t0;
  await app.app.inject({ method: 'POST', url: `/invitations/${inv2.invitation.id}/regenerate`, headers: { cookie: admin } }).then((r) => r.json().invitation ? app.app.inject({ method: 'POST', url: `/invitations/${r.json().invitation.id}/revoke`, headers: { cookie: admin } }) : null);
});

test('6. sem Verum Wallet: cliente destaca download e desabilita cadastro; convite permanece consumido; "gerar novo link" revoga o anterior', async () => {
  const { choiceState } = await import('../public/js/onboarding-logic.js');
  const cs = choiceState({ walletAvailable: false, downloadUrl: '' });
  assert.equal(cs.primary, 'download'); assert.equal(cs.signupDisabled, true); assert.match(cs.afterInstall, /peça um novo link/);
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  await open(inv.token);
  const { rows: [a] } = await app.db.query<any>(`SELECT status FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(a.status, 'ABERTO');
  const rg = await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/regenerate`, headers: { cookie: admin } });
  assert.equal(rg.statusCode, 200); const n = rg.json();
  assert.equal(n.invitation.roleKey, 'INTERMEDIACAO_COMPRA'); assert.equal(n.invitation.bps, inv.invitation.bps); assert.notEqual(n.link, inv.link);
  const { rows: [b] } = await app.db.query<any>(`SELECT status, replaced_by_id FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(b.status, 'REVOGADO'); assert.equal(b.replaced_by_id, n.invitation.id);
  assert.equal((await open(inv.token)).statusCode, 404);
  await app.app.inject({ method: 'POST', url: `/invitations/${n.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('7. resumo da operação só aparece após o código correto', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  const o = await open(inv.token); const cookie = cookieOf(o, 'votc_inv')!;
  assert.equal(JSON.stringify(o.json()).includes('OTC-0001'), false);
  const rs = await stepCall('/invite/resume', inv.token, cookie); assert.equal(rs.json().summary, null); assert.equal(rs.json().step, 'CHOICE');
  const bad = await stepCall('/invite/verify-code', inv.token, cookie, { code: 'VOTC-ZZZZZZ' });
  assert.equal(bad.statusCode, 400); assert.equal(bad.json().summary, undefined); assert.equal(bad.json().remaining, 4);
  const ok = await stepCall('/invite/verify-code', inv.token, cookie, { code: inv.code });
  assert.equal(ok.statusCode, 200); const s = ok.json().summary;
  assert.equal(s.dealCode, 'OTC-0001'); assert.equal(s.roleKey, 'INTERMEDIACAO_COMPRA'); assert.equal(s.bps, 50); assert.equal(s.direction.deliver, 'BTC:bitcoin-demo');
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('8. cinco códigos errados bloqueiam o convite', async () => {
  const admin = await loginAs('pm01');
  const inv = await createInvite(admin);
  const o = await open(inv.token); const cookie = cookieOf(o, 'votc_inv')!;
  for (let i = 1; i <= 4; i++) { const r = await stepCall('/invite/verify-code', inv.token, cookie, { code: 'VOTC-AAAAAA' }); assert.equal(r.statusCode, 400); assert.equal(r.json().remaining, 5 - i); }
  const fifth = await stepCall('/invite/verify-code', inv.token, cookie, { code: 'VOTC-AAAAAA' });
  assert.equal(fifth.statusCode, 404); assert.equal(fifth.json().message, GENERIC);
  const { rows: [row] } = await app.db.query<any>(`SELECT status, failed_attempts FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(row.status, 'BLOQUEADO'); assert.equal(row.failed_attempts, 5);
  const right = await stepCall('/invite/verify-code', inv.token, cookie, { code: inv.code }); assert.equal(right.statusCode, 404);
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/regenerate`, headers: { cookie: admin } }).then((r) => app.app.inject({ method: 'POST', url: `/invitations/${r.json().invitation.id}/revoke`, headers: { cookie: admin } }));
});

test('9. expirado, revogado, bloqueado e inexistente devolvem a mesma mensagem', async () => {
  const admin = await loginAs('pm01');
  const t0 = clock;
  const bodies: string[] = [];
  const revoked = await createInvite(admin); await app.app.inject({ method: 'POST', url: `/invitations/${revoked.invitation.id}/revoke`, headers: { cookie: admin } });
  bodies.push((await open(revoked.token)).body);
  const expired = await createInvite(admin); clock = new Date(t0.getTime() + 30 * 3600_000); bodies.push((await open(expired.token)).body); clock = t0;
  const rg = await app.app.inject({ method: 'POST', url: `/invitations/${expired.invitation.id}/regenerate`, headers: { cookie: admin } });
  const blocked = { ...rg.json(), token: rg.json().link.split('/i/')[1] };
  const bo = await open(blocked.token); const bc = cookieOf(bo, 'votc_inv')!;
  for (let i = 0; i < 5; i++) await stepCall('/invite/verify-code', blocked.token, bc, { code: 'VOTC-AAAAAA' });
  bodies.push((await stepCall('/invite/verify-code', blocked.token, bc, { code: blocked.code })).body);
  bodies.push((await open('x'.repeat(43))).body);
  bodies.push((await app.app.inject({ method: 'POST', url: '/invite/open', payload: { token: 'curto' } })).body === '' ? '' : (await open('A'.repeat(43))).body);
  const uniq = new Set(bodies.filter(Boolean));
  assert.equal(uniq.size, 1, [...uniq].join(' | ')); assert.equal(JSON.parse([...uniq][0]).message, GENERIC);
});

test('10. challenge expira em 2 min, é de uso único e rejeita replay', async () => {
  const admin = await loginAs('pm01');
  const { inv, cookie } = await openAndVerify(admin);
  const kp = nacl.sign.keyPair(); const address = base58Encode(kp.publicKey);
  const t0 = clock;
  const ch = (await stepCall('/invite/wallet-challenge', inv.token, cookie, { address })).json();
  assert.match(ch.message, /NÃO autoriza transação/); assert.ok(ch.message.includes(inv.invitation.id)); assert.ok(ch.message.includes('OTC-0001'));
  const signature = base58Encode(nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey));
  clock = new Date(t0.getTime() + 121_000);
  assert.equal((await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch.challengeId, nonce: ch.nonce, signature })).statusCode, 401);
  clock = t0;
  const ch2 = (await stepCall('/invite/wallet-challenge', inv.token, cookie, { address })).json();
  const sig2 = base58Encode(nacl.sign.detached(new TextEncoder().encode(ch2.message), kp.secretKey));
  assert.equal((await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch2.challengeId, nonce: ch2.nonce, signature: sig2 })).statusCode, 200);
  const replay = await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch2.challengeId, nonce: ch2.nonce, signature: sig2 });
  assert.equal(replay.statusCode, 401);
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('11. assinatura de outra chave é rejeitada', async () => {
  const admin = await loginAs('pm01');
  const { inv, cookie } = await openAndVerify(admin);
  const kp = nacl.sign.keyPair(); const other = nacl.sign.keyPair();
  const ch = (await stepCall('/invite/wallet-challenge', inv.token, cookie, { address: base58Encode(kp.publicKey) })).json();
  const sig = base58Encode(nacl.sign.detached(new TextEncoder().encode(ch.message), other.secretKey));
  const r = await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch.challengeId, nonce: ch.nonce, signature: sig });
  assert.equal(r.statusCode, 401);
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('12. WalletAdapter recusa providers que não sejam a Verum Wallet (cliente)', async () => {
  const { selectProvider } = await import('../public/js/wallet-adapter.js');
  assert.throws(() => selectProvider([{ id: 'phantom', isVerumWallet: true }]), /Somente a Verum Wallet/);
  assert.throws(() => selectProvider([]));
});

test('13. carteira já cadastrada pula o cadastro e vincula o convite ao usuário existente', async () => {
  const admin = await loginAs('pm01');
  const { inv, cookie } = await openAndVerify(admin);
  const persona = PERSONAS.find((p) => p.key === 'ic')!;                                            // Lívia Moraes existe, mas não está na DEMO 1
  const ch = (await stepCall('/invite/wallet-challenge', inv.token, cookie, { address: demoAddress(persona.key) })).json();
  const v = await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign(persona.key, ch.message) });
  assert.equal(v.statusCode, 200); assert.equal(v.json().existingUser, true); assert.equal(v.json().step, 'TERMS');
  const su = await stepCall('/invite/signup', inv.token, cookie, { fullName: 'Outro Nome', email: 'x@y.zz', phone: '+5511999999999', country: 'BR' });
  assert.equal(su.statusCode, 409);
  const c = await stepCall('/invite/complete', inv.token, cookie, { acceptTerms: true });
  assert.equal(c.statusCode, 200); assert.ok(cookieOf(c, 'votc_session'));
  const { rows: [row] } = await app.db.query<any>(`SELECT i.status, i.user_id, u.full_name FROM invitations i JOIN users u ON u.id = i.user_id WHERE i.id = $1`, [inv.invitation.id]);
  assert.equal(row.status, 'CONCLUIDO'); assert.equal(row.full_name, persona.name);
  const { rows: [{ n }] } = await app.db.query<any>(`SELECT COUNT(*)::int AS n FROM users WHERE full_name = $1`, [persona.name]); assert.equal(n, 1);
});

test('14. mesma carteira em duas funções na mesma versão é rejeitada', async () => {
  const admin = await loginAs('pm01');
  const dealId = await demo1();
  const s = await app.app.inject({ method: 'POST', url: `/api/deals/${dealId}/slots`, headers: { cookie: admin }, payload: { roleKey: 'PAY_MASTER' } });
  assert.equal(s.statusCode, 200);
  const { inv, cookie } = await openAndVerify(admin, 'PAY_MASTER', dealId, 2);
  assert.equal(inv.invitation.roleSeq, 2);
  const ch = (await stepCall('/invite/wallet-challenge', inv.token, cookie, { address: demoAddress('ic') })).json();  // Lívia já ocupa Intermediação Compra (teste 13)
  const v = await stepCall('/invite/wallet-verify', inv.token, cookie, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign('ic', ch.message) });
  assert.equal(v.statusCode, 409); assert.equal(v.json().error, 'WALLET_ALREADY_IN_VERSION');
  await assert.rejects(app.db.query(
    `INSERT INTO partnership_participants (version_id, role_key, seq, user_id, wallet_id)
     SELECT pp.version_id, 'VENDEDOR', 9, pp.user_id, pp.wallet_id FROM partnership_participants pp JOIN partnership_versions pv ON pv.id = pp.version_id
      WHERE pp.wallet_id = (SELECT id FROM wallets WHERE address = $1) AND pv.status = 'DRAFT'`, [demoAddress('ic')]), /unique|duplicate/i);   // o banco também recusa
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
  await app.app.inject({ method: 'DELETE', url: `/api/deals/${dealId}/slots/${s.json().participantId}`, headers: { cookie: admin } });
});

test('15. função e percentual do convite não podem ser alterados pelo parceiro (nem pelo banco)', async () => {
  const admin = await loginAs('pm01');
  const { inv, cookie } = await openAndVerify(admin, 'INTERMEDIACAO_VENDA', (await app.db.query<any>(`SELECT id FROM deals WHERE code = 'OTC-0003'`)).rows[0].id).catch(async () => {
    // OTC-0003 está aguardando aceites: convite exige DRAFT → usamos uma oferta nova
    const r = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: admin }, payload: { kind: 'UNICA', title: 'Teste 15', deliverAssetId: 'BTC:bitcoin-demo', receiveAssetId: 'USDT:solana-demo', volumeText: '1 BTC', grade: '10/5', roles: ['VENDEDOR', 'COMPRADOR'] } });
    return openAndVerify(admin, 'VENDEDOR', r.json().dealId);
  });
  const kp = nacl.sign.keyPair();
  assert.equal((await walletProve(inv.token, cookie, kp)).statusCode, 200);
  const tamper = await stepCall('/invite/signup', inv.token, cookie, { fullName: 'Ana Souza', email: 'ana15@ex.test', phone: '+5511988887777', country: 'BR', bps: 9999, roleKey: 'PAY_MASTER' });
  assert.equal(tamper.statusCode, 400);                                                               // campos extras recusados pelo schema
  await assert.rejects(app.db.query(`UPDATE invitations SET bps = 9999 WHERE id = $1`, [inv.invitation.id]), /INVITE_IMMUTABLE/);
  await assert.rejects(app.db.query(`UPDATE invitations SET role_id = 'PAY_MASTER' WHERE id = $1`, [inv.invitation.id]), /INVITE_IMMUTABLE/);
  const { rows: [row] } = await app.db.query<any>(`SELECT bps, role_id FROM invitations WHERE id = $1`, [inv.invitation.id]);
  assert.equal(row.bps, inv.invitation.bps); assert.equal(row.role_id, inv.invitation.roleKey);
  await app.app.inject({ method: 'POST', url: `/invitations/${inv.invitation.id}/revoke`, headers: { cookie: admin } });
});

test('16. telefone/e-mail mascarados antes de CONCLUÍDO e visíveis depois', async () => {
  const admin = await loginAs('pm01');
  const r = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: admin }, payload: { kind: 'UNICA', title: 'Teste 16', deliverAssetId: 'BTC:bitcoin-demo', receiveAssetId: 'USDT:solana-demo', volumeText: '1 BTC', grade: '10/5', roles: ['VENDEDOR'] } });
  const dealId = r.json().dealId;
  const { inv, cookie, summary } = await openAndVerify(admin, 'VENDEDOR', dealId);
  const pm = summary.participants.find((p: any) => p.name === 'Rafael Monteiro');
  assert.match(pm.email, /^r\*\*\*@/); assert.match(pm.phone, /^\+55 \*\* \*\*\*\*\*-\d{4}$/);
  const kp = nacl.sign.keyPair();
  await walletProve(inv.token, cookie, kp);
  await stepCall('/invite/signup', inv.token, cookie, { fullName: 'Bruno Lima', email: 'bruno16@ex.test', phone: '+55 11 98888-0016', country: 'BR' });
  const before = await app.app.inject({ method: 'GET', url: `/api/deals/${dealId}`, headers: { cookie: admin } });
  const slotBefore = before.json().participants.find((p: any) => p.roleKey === 'VENDEDOR');
  assert.equal(slotBefore.filled, false); assert.equal(slotBefore.email, null);                      // até concluir, a cadeira segue vazia
  const c = await stepCall('/invite/complete', inv.token, cookie, { acceptTerms: true }); assert.equal(c.statusCode, 200);
  const sess = cookieOf(c, 'votc_session')!;
  const after = await app.app.inject({ method: 'GET', url: `/api/deals/${dealId}`, headers: { cookie: sess } });
  const pmAfter = after.json().participants.find((p: any) => p.name === 'Rafael Monteiro');
  assert.equal(pmAfter.contactVisible, true); assert.equal(pmAfter.phone, '+55 11 98811-4021'); assert.match(pmAfter.email, /^rafael/);
  const asAdmin = await app.app.inject({ method: 'GET', url: `/api/deals/${dealId}`, headers: { cookie: admin } });
  assert.equal(asAdmin.json().participants.find((p: any) => p.name === 'Bruno Lima').email, 'bruno16@ex.test');
});

test('17. login posterior por assinatura funciona; link antigo não funciona', async () => {
  const admin = await loginAs('pm01');
  const r = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: admin }, payload: { kind: 'UNICA', title: 'Teste 17', deliverAssetId: 'BTC:bitcoin-demo', receiveAssetId: 'USDT:solana-demo', volumeText: '1 BTC', grade: '10/5', roles: ['COMPRADOR'] } });
  const { inv, cookie } = await openAndVerify(admin, 'COMPRADOR', r.json().dealId);
  const kp = nacl.sign.keyPair(); const address = base58Encode(kp.publicKey);
  await walletProve(inv.token, cookie, kp);
  await stepCall('/invite/signup', inv.token, cookie, { fullName: 'Carla Nunes', email: 'carla17@ex.test', phone: '+55 11 98888-0017', country: 'BR' });
  assert.equal((await stepCall('/invite/complete', inv.token, cookie, { acceptTerms: true })).statusCode, 200);
  const ch = (await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address }, remoteAddress: freshIp() })).json();
  const v = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', payload: { challengeId: ch.challengeId, nonce: ch.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey)) }, remoteAddress: freshIp() });
  assert.equal(v.statusCode, 200);
  const me = await app.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieOf(v, 'votc_session')! } });
  assert.equal(me.json().fullName, 'Carla Nunes');
  assert.equal((await open(inv.token)).statusCode, 404);
  assert.equal((await stepCall('/invite/resume', inv.token, cookie)).statusCode, 404);
  const unknown = nacl.sign.keyPair(); const ch2 = (await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address: base58Encode(unknown.publicKey) }, remoteAddress: freshIp() })).json();
  const v2 = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', payload: { challengeId: ch2.challengeId, nonce: ch2.nonce, signature: base58Encode(nacl.sign.detached(new TextEncoder().encode(ch2.message), unknown.secretKey)) }, remoteAddress: freshIp() });
  assert.equal(v2.statusCode, 403);                                                                   // sem cadastro público
});

test('18. rate limit em open, verify-code e wallet-verify', async () => {
  const ip = freshIp();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await open('B'.repeat(43), ip)).statusCode;
  assert.equal(last, 429);
  const ip2 = freshIp();
  for (let i = 0; i < 12; i++) last = (await stepCall('/invite/verify-code', 'C'.repeat(43), undefined, { code: 'VOTC-AAAAAA' }, ip2)).statusCode;
  assert.equal(last, 429);
  const ip3 = freshIp();
  for (let i = 0; i < 12; i++) last = (await stepCall('/invite/wallet-verify', 'C'.repeat(43), undefined, { challengeId: '00000000-0000-0000-0000-000000000000', nonce: '1111111111111111', signature: '1111111111111111' }, ip3)).statusCode;
  assert.equal(last, 429);
});

test('19. auditoria registra eventos de convite sem token em claro e sem dado de contato', async () => {
  const { rows } = await app.db.query<any>(`SELECT action, old_value::text AS o, new_value::text AS n, meta::text AS m FROM audit_logs WHERE action LIKE 'INVITE_%' OR action IN ('SIGNUP_COMPLETED','WALLET_CONNECTED')`);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['INVITE_CREATED', 'INVITE_OPENED', 'INVITE_CODE_FAILED', 'INVITE_BLOCKED', 'INVITE_EXPIRED', 'INVITE_REVOKED', 'INVITE_REGENERATED', 'INVITE_COMPLETED', 'SIGNUP_COMPLETED', 'WALLET_CONNECTED']) assert.ok(actions.has(a), a);
  const blob = rows.map((r) => `${r.o}${r.n}${r.m}`).join('\n');
  assert.doesNotMatch(blob, /VOTC-[A-Z2-9]{6}/); assert.doesNotMatch(blob, /@ex\.test|@demo\.verum|98888-00/); assert.doesNotMatch(blob, /[A-Za-z0-9_-]{43}/);
  await assert.rejects(app.db.query(`DELETE FROM audit_logs WHERE action = 'INVITE_OPENED'`), /IMMUTABLE_ROW/);
});

test('20. e2e em DEMO: admin gera → parceiro abre → código → wallet mock → cadastro → termos → Deal Room', async () => {
  const admin = await loginAs('pm01');
  const r = await app.app.inject({ method: 'POST', url: '/api/deals', headers: { cookie: admin }, payload: { kind: 'UNICA', title: 'Teste 20', deliverAssetId: 'USDT:solana-demo', receiveAssetId: 'USD:cash', volumeText: '100.000 USDT', grade: '5/3', roles: ['VENDEDOR', 'COMPRADOR'] } });
  const dealId = r.json().dealId;
  const inv = await createInvite(admin, 'VENDEDOR', dealId);
  const robot = await app.app.inject({ method: 'GET', url: `/i/${inv.token}` }); assert.equal(robot.statusCode, 200);      // prévia
  const o = await open(inv.token); const cookie = cookieOf(o, 'votc_inv')!; assert.equal(o.json().step, 'CHOICE');
  assert.equal((await stepCall('/invite/verify-code', inv.token, cookie, { code: inv.code })).statusCode, 200);
  const kp = nacl.sign.keyPair();
  assert.equal((await walletProve(inv.token, cookie, kp)).json().step, 'SIGNUP');
  assert.equal((await stepCall('/invite/signup', inv.token, cookie, { fullName: 'Diego Prado', email: 'diego20@ex.test', phone: '+595 981 000-020', country: 'PY' })).statusCode, 200);
  const c = await stepCall('/invite/complete', inv.token, cookie, { acceptTerms: true });
  assert.equal(c.statusCode, 200); assert.equal(c.json().dealId, dealId);
  const room = await app.app.inject({ method: 'GET', url: `/api/deals/${dealId}`, headers: { cookie: cookieOf(c, 'votc_session')! } });
  assert.equal(room.statusCode, 200); assert.equal(room.json().me.role, 'Vendedor'); assert.equal(room.json().isAdmin, false);
  assert.equal(room.json().hasOffPlatformLeg, true); assert.match(room.json().honestyNotice, /não verifica/);
  const other = await app.app.inject({ method: 'GET', url: `/api/deals/${await demo1()}`, headers: { cookie: cookieOf(c, 'votc_session')! } });
  assert.equal(other.statusCode, 404);                                                                // autorização por operação
});
