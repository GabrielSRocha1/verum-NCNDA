import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { demoAddress, demoSign } from '../src/demo.ts';

let clock = new Date('2026-10-05T12:00:00Z');
let app: BuiltApp;
let ip = 0;
const nextIp = () => `10.1.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
const cookieOf = (res: any) => (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]).find((c: string) => c?.startsWith('votc_session='))!.split(';')[0];
async function loginAs(key: string) {
  const ch = (await app.app.inject({ method: 'POST', url: '/auth/wallet-challenge', payload: { address: demoAddress(key) }, remoteAddress: nextIp() })).json();
  const v = await app.app.inject({ method: 'POST', url: '/auth/wallet-verify', payload: { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign(key, ch.message) }, remoteAddress: nextIp() });
  return cookieOf(v);
}
const get = (url: string, cookie: string) => app.app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: any) => app.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const put = (url: string, cookie: string, payload?: any) => app.app.inject({ method: 'PUT', url, headers: { cookie }, payload });
const deal = async (code: string) => (await app.db.query<any>(`SELECT id FROM deals WHERE code = $1`, [code])).rows[0].id as string;
async function signAs(key: string, dealId: string) {
  const c = await loginAs(key);
  const ch = (await post(`/api/deals/${dealId}/agreement/challenge`, c)).json();
  return post(`/api/deals/${dealId}/agreement/sign`, c, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign(key, ch.message) });
}

before(async () => { app = await buildApp({ env: { DATA_DIR: 'memory', DEMO_MODE: 'true', COOKIE_SECURE: 'false' } as any, config: { now: () => clock } }); });
after(async () => { await app.app.close(); });

test('seed DEMO: 3 mesas com as somas das grades (700 / 2500 / 1200) e estados esperados', async () => {
  const admin = await loginAs('pm01');
  const { deals } = (await get('/api/deals', admin)).json();
  const by = Object.fromEntries(deals.map((d: any) => [d.code, d]));
  assert.equal(by['OTC-0001'].version.status, 'DRAFT'); assert.equal(by['OTC-0001'].linesValidation.sum, 700); assert.equal(by['OTC-0001'].offer.kindLabel, 'OFERTA ÚNICA');
  assert.equal(by['OTC-0002'].version.status, 'LOCKED'); assert.equal(by['OTC-0002'].linesValidation.sum, 2500); assert.equal(by['OTC-0002'].signatures.label, '7/7 CONFIRMADOS');
  assert.equal(by['OTC-0002'].offer.kindLabel, 'PARCERIA PERMANENTE'); assert.equal(by['OTC-0002'].offer.businessName, 'Aurora Commodities');
  assert.ok(by['OTC-0002'].lines.some((l: any) => l.kind === 'RESIDUO' && l.bps === 1 && l.role === 'Pay Master / Ligação'));
  assert.equal(by['OTC-0002'].hasOffPlatformLeg, true); assert.match(by['OTC-0002'].honestyNotice, /não verifica/);
  assert.equal(by['OTC-0003'].version.status, 'PENDING_SIGNATURES'); assert.equal(by['OTC-0003'].linesValidation.sum, 1200);
  const d3 = (await get(`/api/deals/${by['OTC-0003'].id}`, admin)).json();
  const badges = d3.participants.filter((p: any) => p.isPayMaster).map((p: any) => p.payMasterBadge);
  assert.deepEqual(badges, ['PAY MASTER 01', 'PAY MASTER 02']);
  assert.equal(d3.participants[0].isPayMaster, true);                                                 // Pay Master sempre no topo da pilha
  assert.deepEqual(by['OTC-0001'].legs.map((l: any) => l.chip), ['ON-CHAIN', 'ON-CHAIN']);
  assert.equal(by['OTC-0002'].legs.find((l: any) => l.side === 'ENTREGA').chip, 'FORA DA PLATAFORMA — NÃO GARANTIDO POR CONTRATO');
});

test('12 LOCKED: alterar percentual, carteira ou participante é recusado pela API e pelo banco; política de resíduo travada', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0002');
  const d = (await get(`/api/deals/${id}`, admin)).json();
  const lines = d.lines.map((l: any) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq, bps: l.bps, kind: l.kind }));
  lines[0].bps -= 100; lines[1].bps += 100;
  const r = await put(`/api/deals/${id}/lines`, admin, { lines }); assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'VERSION_LOCKED');
  assert.equal((await post(`/api/deals/${id}/slots`, admin, { roleKey: 'PAY_MASTER' })).statusCode, 409);
  assert.equal((await post(`/api/deals/${id}/slots/${d.participants[1].id}/vacate`, admin)).statusCode, 409);
  assert.equal((await post('/invitations', admin, { dealId: id, roleKey: 'VENDEDOR' })).statusCode, 409);
  await assert.rejects(app.db.query(`UPDATE allocation_lines SET bps = bps + 1 WHERE version_id = $1`, [d.version.id]), /LOCKED_VERSION/);
  await assert.rejects(app.db.query(`DELETE FROM allocation_lines WHERE version_id = $1`, [d.version.id]), /LOCKED_VERSION/);
  await assert.rejects(app.db.query(`UPDATE partnership_participants SET wallet_id = NULL, user_id = NULL WHERE version_id = $1`, [d.version.id]), /LOCKED_VERSION/);
  await assert.rejects(app.db.query(`UPDATE partnership_versions SET residual_policy = 'TO_PAYER' WHERE id = $1`, [d.version.id]), /VERSION_IMMUTABLE/);
  await assert.rejects(app.db.query(`UPDATE partnership_versions SET terms_hash = repeat('0', 64) WHERE id = $1`, [d.version.id]), /VERSION_IMMUTABLE/);
  await assert.rejects(app.db.query(`UPDATE partnership_versions SET status = 'DRAFT' WHERE id = $1`, [d.version.id]), /INVALID_TRANSITION/);
  await assert.rejects(app.db.query(`UPDATE signatures SET signature = 'x' WHERE version_id = $1`, [d.version.id]), /SIGNATURE_APPEND_ONLY/);
});

test('12 banco: soma de bps inconsistente impede sair de DRAFT; LOCKED exige todas as assinaturas', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0001');
  const d = (await get(`/api/deals/${id}`, admin)).json();
  await assert.rejects(app.db.query(`UPDATE partnership_versions SET terms_hash = repeat('a', 64), status = 'PENDING_SIGNATURES' WHERE id = $1`, [d.version.id]), /PARTICIPANTS_INCOMPLETE|BPS_SUM/);
  const lines = d.lines.map((l: any) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq, bps: l.bps, kind: l.kind }));
  lines[0].bps = 399;
  const r = await put(`/api/deals/${id}/lines`, admin, { lines }); assert.equal(r.statusCode, 200); assert.equal(r.json().validation.ok, false);
  const s = await post(`/api/deals/${id}/submit`, admin); assert.equal(s.statusCode, 400); assert.equal(s.json().error, 'BPS_SUM_MISMATCH');
  lines[0].bps = 400; await put(`/api/deals/${id}/lines`, admin, { lines });
  const s2 = await post(`/api/deals/${id}/submit`, admin); assert.equal(s2.statusCode, 400); assert.equal(s2.json().error, 'PARTICIPANTS_INCOMPLETE');  // cadeira vazia
  const id3 = await deal('OTC-0003');
  const v3 = (await get(`/api/deals/${id3}`, admin)).json().version.id;
  await assert.rejects(app.db.query(`UPDATE partnership_versions SET status = 'LOCKED' WHERE id = $1`, [v3]), /SIGNATURES_INCOMPLETE: 5\/6/);
});

test('9 fluxo: k/N sobe por assinatura real; todos assinam → LOCKED; reabrir DRAFT invalida assinaturas', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0003');
  const before = (await get(`/api/deals/${id}`, admin)).json(); assert.equal(before.signatures.label, '5/6 CONFIRMADOS');
  const dup = await signAs('vend', id); assert.equal(dup.statusCode, 409);                             // já assinou
  const re = await post(`/api/deals/${id}/reopen`, admin); assert.equal(re.statusCode, 200); assert.equal(re.json().invalidated, 5);
  assert.equal((await get(`/api/deals/${id}`, admin)).json().signatures.k, 0);
  assert.equal((await post(`/api/deals/${id}/submit`, admin)).statusCode, 200);
  let last: any;
  for (const k of ['vend', 'gv', 'gc', 'pm02', 'pm01']) { last = (await signAs(k, id)).json(); assert.equal(last.status, 'PENDING_SIGNATURES'); }
  assert.equal(last.k, 5);
  const fin = (await signAs('comp', id)).json(); assert.equal(fin.status, 'LOCKED'); assert.equal(fin.k, 6);
  const d = (await get(`/api/deals/${id}`, admin)).json(); assert.equal(d.version.status, 'LOCKED'); assert.ok(d.version.lockedAt);
  const { rows } = await app.db.query<any>(`SELECT action FROM audit_logs WHERE deal_id = $1 AND action IN ('DEAL_LOCKED','SIGNATURES_INVALIDATED','VERSION_REOPENED')`, [id]);
  assert.deepEqual(rows.map((r) => r.action).sort(), ['DEAL_LOCKED', 'SIGNATURES_INVALIDATED', 'VERSION_REOPENED']);
});

test('10 nova versão: clona participantes e linhas em DRAFT, exige novos aceites; a anterior fica superseded', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0002');
  const v1 = (await get(`/api/deals/${id}`, admin)).json();
  const nv = await post(`/api/deals/${id}/new-version`, admin); assert.equal(nv.statusCode, 200); assert.equal(nv.json().versionNo, 2);
  const v2 = (await get(`/api/deals/${id}`, admin)).json();
  assert.equal(v2.version.status, 'DRAFT'); assert.equal(v2.version.no, 2); assert.equal(v2.signatures.k, 0); assert.equal(v2.participants.length, v1.participants.length);
  assert.deepEqual(v2.lines.map((l: any) => [l.lineKey, l.bps]), v1.lines.map((l: any) => [l.lineKey, l.bps]));
  const lines = v2.lines.map((l: any) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq, bps: l.bps, kind: l.kind }));
  lines[1].bps -= 10; lines[2].bps += 10;
  assert.equal((await put(`/api/deals/${id}/lines`, admin, { lines, residualPolicy: 'TO_PAYER' })).statusCode, 200);
  assert.equal((await post(`/api/deals/${id}/submit`, admin)).statusCode, 200);
  const sub = (await get(`/api/deals/${id}`, admin)).json();
  assert.notEqual(sub.version.termsHash, v1.version.termsHash); assert.equal(sub.version.residualPolicy, 'TO_PAYER');
  const { rows: [old] } = await app.db.query<any>(`SELECT status, superseded_by_id FROM partnership_versions WHERE id = $1`, [v1.version.id]);
  assert.equal(old.status, 'LOCKED'); assert.equal(old.superseded_by_id, sub.version.id);
  for (const k of ['vend', 'gv', 'iv', 'ic', 'gc', 'comp', 'pm01']) await signAs(k, id);
  assert.equal((await get(`/api/deals/${id}`, admin)).json().version.status, 'LOCKED');
});

test('11 settlement simulado: AUTORIZAR LIQUIDAÇÃO (assinatura separada) → FUNDED → SETTLED com distribuição exata e resíduo', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0002');
  const pv = (await get(`/api/deals/${id}/settlement/preview`, admin)).json();
  assert.equal(pv.demo, true); assert.equal(pv.protectedByContract, false);
  const ch = (await post(`/api/deals/${id}/settlement/challenge`, admin)).json();
  assert.match(ch.message, /AUTORIZAR LIQUIDAÇÃO/); assert.match(ch.message, /SIMULADO \(DEMO\)/); assert.match(ch.message, /autoriza a liquidação/);
  assert.equal((await post(`/api/deals/${id}/settlement/execute`, admin)).statusCode, 409);           // só depois de FUNDED
  const f = await post(`/api/deals/${id}/settlement/fund`, admin, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign('pm01', ch.message) });
  assert.equal(f.statusCode, 200, f.body); assert.equal(f.json().status, 'FUNDED');
  const ex = await post(`/api/deals/${id}/settlement/execute`, admin); assert.equal(ex.statusCode, 200);
  const st = ex.json(); assert.equal(st.status, 'SETTLED');
  const total = st.lines.reduce((a: bigint, l: any) => a + BigInt(l.amount), 0n);
  assert.equal(total.toString(), st.poolAmount);
  assert.equal(st.poolAmount, (BigInt(st.referenceAmount) * 2500n / 10000n).toString());
  assert.ok(st.lines.some((l: any) => l.kind === 'RESIDUO'));                                           // resíduo exibido
  const d = (await get(`/api/deals/${id}`, admin)).json();
  assert.equal(d.version.status, 'SETTLED'); assert.equal(d.payment.mode, 'DIRECT');
  await assert.rejects(app.db.query(`UPDATE settlements SET status = 'FUNDED' WHERE id = $1`, [st.id]), /SETTLEMENT_FINAL/);
  const { rows } = await app.db.query<any>(`SELECT action FROM audit_logs WHERE deal_id = $1 AND action LIKE 'SETTLEMENT_%' ORDER BY id`, [id]);
  assert.deepEqual(rows.map((r) => r.action), ['SETTLEMENT_CREATED', 'SETTLEMENT_FUNDED', 'SETTLEMENT_EXECUTING', 'SETTLEMENT_SETTLED']);
  assert.equal((await post(`/api/deals/${id}/new-version`, admin)).statusCode, 409);                   // SETTLED não vira nova versão
});

test('13 documentos: versão + SHA-256 + aceite assinado; versão nova exige novo aceite; conteúdo imutável', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0001');
  const content = Buffer.from('Termos da operação v1').toString('base64');
  const add = await post(`/api/deals/${id}/documents`, admin, { name: 'Termos', mime: 'text/plain', contentBase64: content });
  assert.equal(add.statusCode, 200); assert.match(add.json().sha256, /^[0-9a-f]{64}$/);
  const vend = await loginAs('vend');
  assert.equal((await post(`/api/deals/${id}/documents`, vend, { name: 'X', mime: 'text/plain', contentBase64: content })).statusCode, 403);
  const ch = (await post(`/api/deals/${id}/documents/${add.json().versionId}/challenge`, vend)).json();
  assert.ok(ch.message.includes(add.json().sha256));
  const acc = await post(`/api/deals/${id}/documents/${add.json().versionId}/accept`, vend, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign('vend', ch.message) });
  assert.equal(acc.statusCode, 200);
  const l1 = (await get(`/api/deals/${id}/documents`, vend)).json().documents; assert.equal(l1[0].iAccepted, true); assert.equal(l1[0].acceptedBy.length, 1);
  const v2 = await post(`/api/deals/${id}/documents`, admin, { documentId: add.json().documentId, mime: 'text/plain', contentBase64: Buffer.from('v2').toString('base64') });
  assert.equal(v2.json().versionNo, 2);
  const l2 = (await get(`/api/deals/${id}/documents`, vend)).json().documents;
  assert.equal(l2.find((x: any) => x.versionNo === 2).iAccepted, false); assert.equal(l2.find((x: any) => x.versionNo === 1).status, 'SUBSTITUÍDO');
  const dl = await get(`/api/deals/${id}/documents/${v2.json().versionId}/content`, vend); assert.equal(dl.statusCode, 200); assert.equal(dl.body, 'v2');
  await assert.rejects(app.db.query(`UPDATE document_versions SET content = 'x' WHERE id = $1`, [v2.json().versionId]), /IMMUTABLE_ROW/);
  const comp = (await get(`/api/deals/${id}/compliance`, admin)).json();
  assert.match(comp.notice, /não emite aprovação regulatória/); assert.ok(comp.items.every((i: any) => !/aprovado pelo banco central|garantido|legalizada/i.test(i.statuses.join(' '))));
});

test('4.2 parceria permanente: nova oferta do mesmo Negócio herda parceiros, papéis e linhas', async () => {
  const admin = await loginAs('pm01');
  const { businesses } = (await get('/api/businesses', admin)).json();
  const biz = businesses.find((b: any) => b.name === 'Aurora Commodities');
  const r = await post('/api/deals', admin, { kind: 'PERMANENTE', businessId: biz.id, title: 'Aurora — lote 2', deliverAssetId: 'PHYSICAL:asset', receiveAssetId: 'USDT:solana-demo', volumeText: '20 unidades', grade: '25/15' });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().inherited, true);
  const d = (await get(`/api/deals/${r.json().dealId}`, admin)).json();
  assert.equal(d.participants.filter((p: any) => p.filled).length, 7); assert.equal(d.version.status, 'DRAFT'); assert.equal(d.signatures.k, 0);
  assert.equal(d.linesValidation.sum, 2500);
  const asVend = await get(`/api/deals/${r.json().dealId}`, await loginAs('vend')); assert.equal(asVend.statusCode, 200);
  assert.equal((await post('/api/deals', await loginAs('vend'), { kind: 'PERMANENTE', businessId: biz.id, title: 'Tentativa de terceiro', deliverAssetId: 'PHYSICAL:asset', receiveAssetId: 'USDT:solana-demo', volumeText: '1', grade: '25/15' })).statusCode, 403);
});

test('0/16 regras absolutas: sem cadastro público, mainnet recusada, ativo lookalike recusado, autorização por operação, headers de segurança', async () => {
  assert.equal((await app.app.inject({ method: 'POST', url: '/invite/signup', payload: { token: 'A'.repeat(43), fullName: 'Ana Beatriz Souza', email: 'ana@exemplo.test', phone: '+5511999999999', country: 'BR' } })).statusCode, 404);
  assert.equal((await app.app.inject({ method: 'GET', url: '/api/deals' })).statusCode, 401);
  await assert.rejects(buildApp({ env: { DATA_DIR: 'memory', MAINNET_ENABLED: 'true' } as any, seed: false }), /mainnet exige revisão/);
  await assert.rejects(buildApp({ env: { DATA_DIR: 'memory', SOLANA_NETWORK: 'solana-mainnet' } as any, seed: false }), /Mainnet está desligada/);
  await assert.rejects(buildApp({ env: { DATA_DIR: 'memory', DEMO_MODE: 'false' } as any, seed: false }), /SESSION_SECRET obrigatório/);
  const admin = await loginAs('pm01');
  const bad = await post('/api/deals', admin, { kind: 'UNICA', title: 'Mainnet proibida', deliverAssetId: 'USDT:solana-mainnet', receiveAssetId: 'BTC:bitcoin-demo', volumeText: '1', grade: '5/2' });
  assert.equal(bad.statusCode, 400); assert.match(bad.json().message, /recusado/);
  const vend = await loginAs('vend');
  const id3 = await deal('OTC-0003');
  assert.equal((await post('/invitations', vend, { dealId: id3, roleKey: 'COMPRADOR' })).statusCode, 403);
  assert.equal((await get(`/invitations?dealId=${id3}`, vend)).json().invitations.length, 0);
  const res = await app.app.inject({ method: 'GET', url: '/api/config' });
  assert.match(res.headers['content-security-policy'] as string, /script-src 'self'/); assert.equal(res.headers['referrer-policy'], 'no-referrer'); assert.equal(res.headers['x-frame-options'], 'DENY');
  const r404 = await get(`/api/deals/00000000-0000-0000-0000-000000000000/qr/00000000-0000-0000-0000-000000000000`, vend); assert.equal(r404.statusCode, 404);
});

test('11 QR de parceiro: endereço público, rótulo de pagamento direto, DEMO sem deep link inventado, auditoria sem dado pessoal', async () => {
  const admin = await loginAs('pm01');
  const id = await deal('OTC-0003');
  const d = (await get(`/api/deals/${id}`, admin)).json();
  const p = d.participants.find((x: any) => x.roleKey === 'VENDEDOR');
  const qr = (await get(`/api/deals/${id}/qr/${p.id}`, admin)).json();
  assert.equal(qr.address, demoAddress('vend')); assert.ok(qr.uri.startsWith(`solana:${qr.address}`)); assert.equal(qr.demo, true);
  assert.equal(qr.payment.mode, 'DIRECT'); assert.match(qr.payment.label, /PAGAMENTO DIRETO/); assert.equal(qr.deepLink, null); assert.equal(qr.amountLabel, null);  // vendedor sem comissão
  const { rows: [ev] } = await app.db.query<any>(`SELECT new_value, meta FROM audit_logs WHERE action = 'QR_VIEWED' ORDER BY id DESC LIMIT 1`);
  assert.equal(ev.new_value, null); assert.equal(ev.meta, null);
});
