// MODO DEMO — DEMO / TESTNET — NO REAL FUNDS.
// Personas fictícias com chaves Ed25519 DERIVADAS DE SEMENTES PÚBLICAS (constantes no código).
// Servem só para demonstrar o fluxo com assinaturas reais verificadas pelo backend.
// Nunca usar essas chaves fora do DEMO: qualquer pessoa consegue derivá-las.
import nacl from 'tweetnacl';
import { base58Encode } from './lib/crypto.ts';
import type { Queryable } from './db.ts';
import type { Ctx } from './services/auth.ts';
import { createOffer, submitForSignatures, agreementChallenge, signAgreement, type LineInput } from './services/partnership.ts';
import { currentVersion } from './services/deals.ts';

export interface Persona { key: string; name: string; email: string; phone: string; country: string; hint: string }

export const PERSONAS: Persona[] = [
  { key: 'pm01', name: 'Rafael Monteiro', email: 'rafael.monteiro@demo.verum', phone: '+55 11 98811-4021', country: 'BR', hint: 'Pay Master 01 · admin das mesas' },
  { key: 'pm02', name: 'Helena Duarte', email: 'helena.duarte@demo.verum', phone: '+595 981 552-310', country: 'PY', hint: 'Pay Master 02 (DEMO 3)' },
  { key: 'vend', name: 'Marcos Albuquerque', email: 'marcos.albuquerque@demo.verum', phone: '+55 21 99702-1188', country: 'BR', hint: 'Vendedor' },
  { key: 'gv', name: 'Camila Furtado', email: 'camila.furtado@demo.verum', phone: '+55 41 99133-7720', country: 'BR', hint: 'Grupo Venda' },
  { key: 'iv', name: 'Diego Sampaio', email: 'diego.sampaio@demo.verum', phone: '+55 31 98455-0293', country: 'BR', hint: 'Intermediação Venda' },
  { key: 'ic', name: 'Lívia Moraes', email: 'livia.moraes@demo.verum', phone: '+55 47 99260-6614', country: 'BR', hint: 'Intermediação Compra (DEMO 2)' },
  { key: 'gc', name: 'Tiago Rezende', email: 'tiago.rezende@demo.verum', phone: '+55 61 99318-4402', country: 'BR', hint: 'Grupo Compra' },
  { key: 'comp', name: 'Beatriz Lacerda', email: 'beatriz.lacerda@demo.verum', phone: '+1 305 555-0144', country: 'US', hint: 'Comprador' },
];

export function demoKeyPair(key: string): nacl.SignKeyPair {
  const seed = nacl.hash(new TextEncoder().encode(`verum-ncnda-demo-persona:${key}`)).slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}
export const demoAddress = (key: string) => base58Encode(demoKeyPair(key).publicKey);
export function demoSign(key: string, message: string): string {
  return base58Encode(nacl.sign.detached(new TextEncoder().encode(message), demoKeyPair(key).secretKey));
}

async function ensurePersona(q: Queryable, ctx: Ctx, p: Persona): Promise<string> {
  const addr = demoAddress(p.key);
  const { rows: [w] } = await q.query<any>(`SELECT user_id FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, addr]);
  if (w) return w.user_id;
  const { rows: [u] } = await q.query<any>(`INSERT INTO users (full_name, email, phone, country, is_demo, terms_accepted_at) VALUES ($1,$2,$3,$4,true,now()) RETURNING id`,
    [p.name, p.email, p.phone, p.country]);
  await q.query(`INSERT INTO wallets (user_id, network, address, provider) VALUES ($1,$2,$3,'verum-wallet-demo')`, [u.id, ctx.sig.network, addr]);
  return u.id;
}

async function fill(ctx: Ctx, dealId: string, assignments: [string, number, string][], ids: Record<string, string>) {
  await ctx.db.tx(async (q) => {
    const v = await currentVersion(q, dealId);
    for (const [role, seq, persona] of assignments) {
      const { rows: [w] } = await q.query<any>(`SELECT id FROM wallets WHERE user_id = $1`, [ids[persona]]);
      await q.query(`UPDATE partnership_participants SET user_id = $3, wallet_id = $4 WHERE version_id = $1 AND role_key = $2 AND seq = $5`, [v.id, role, ids[persona], w.id, seq]);
      await q.query(`INSERT INTO deal_participants (deal_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [dealId, ids[persona]]);
    }
  });
}

async function setLines(ctx: Ctx, dealId: string, lines: LineInput[]) {
  await ctx.db.tx(async (q) => {
    const v = await currentVersion(q, dealId);
    await q.query(`DELETE FROM allocation_lines WHERE version_id = $1`, [v.id]);
    let pos = 0;
    for (const l of lines) await q.query(`INSERT INTO allocation_lines (version_id, position, line_key, label, role_key, role_seq, bps, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [v.id, pos++, l.lineKey, l.label, l.roleKey, l.roleSeq ?? 1, l.bps, l.kind]);
  });
}

async function signAs(ctx: Ctx, persona: string, userId: string, dealId: string) {
  const ch = await agreementChallenge(ctx, userId, dealId);
  return signAgreement(ctx, userId, dealId, { challengeId: ch.challengeId, nonce: ch.nonce, signature: demoSign(persona, ch.message) });
}

export async function seedDemo(ctx: Ctx): Promise<boolean> {
  const { rows } = await ctx.db.query(`SELECT 1 FROM deals WHERE is_demo LIMIT 1`);
  if (rows.length) return false;
  const ids: Record<string, string> = {};
  await ctx.db.tx(async (q) => { for (const p of PERSONAS) ids[p.key] = await ensurePersona(q, ctx, p); });
  const now = ctx.cfg.now().getTime();
  const day = 86_400_000;
  const net = ctx.cfg.network === 'solana-devnet' ? 'solana-devnet' : 'solana-demo';
  const usd = net === 'solana-devnet' ? 'USDC:solana-devnet' : 'USDT:solana-demo';

  // ---------------- DEMO 1 — OFERTA ÚNICA — BTC → USDT — Grade 7/4 (DRAFT, uma cadeira aguardando convite)
  const d1 = await createOffer(ctx, ids.pm01, {
    kind: 'UNICA', title: 'BTC contra USDT — lote diário', deliverAssetId: 'BTC:bitcoin-demo', receiveAssetId: usd,
    volumeText: 'Mínimo diário de 350 BTC', referenceAmount: '21437500.123457', referenceAssetId: usd, grade: '7/4',
    conditions: [
      'Modo remoto ou presencial',
      'BTC na frente, em tranches a definir',
      'Carteira USDT de baixa movimentação (mínimo 30MM) e carteira BTC',
      'Handshake obrigatório',
      'Sem Satoshi e sem teste AB',
    ],
    validUntil: new Date(now + 7 * day).toISOString(),
  }, { isDemo: true });
  await setLines(ctx, d1.dealId, [
    { lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', bps: 400, kind: 'PAGADOR' },
    { lineKey: 'grupo_compra', label: 'Compra', roleKey: 'GRUPO_COMPRA', bps: 100, kind: 'GRUPO_COMPRA' },
    { lineKey: 'grupo_venda', label: 'Venda', roleKey: 'GRUPO_VENDA', bps: 100, kind: 'GRUPO_VENDA' },
    { lineKey: 'intermediacao_venda', label: 'Intermediários — Venda', roleKey: 'INTERMEDIACAO_VENDA', bps: 50, kind: 'INTERMEDIACAO' },
    { lineKey: 'intermediacao_compra', label: 'Intermediários — Compra', roleKey: 'INTERMEDIACAO_COMPRA', bps: 50, kind: 'INTERMEDIACAO' },
  ]);
  await fill(ctx, d1.dealId, [['VENDEDOR', 1, 'vend'], ['GRUPO_VENDA', 1, 'gv'], ['INTERMEDIACAO_VENDA', 1, 'iv'], ['GRUPO_COMPRA', 1, 'gc'], ['COMPRADOR', 1, 'comp']], ids);

  // ---------------- DEMO 2 — PARCERIA PERMANENTE — Ativo físico → USDT — Grade 25/15 (LOCKED 7/7)
  const d2 = await createOffer(ctx, ids.pm01, {
    kind: 'PERMANENTE', businessName: 'Aurora Commodities', businessTagline: 'Parceria permanente · ativo físico contra USDT',
    title: 'Aurora — lote de 10 unidades', deliverAssetId: 'PHYSICAL:asset', deliverDescription: 'Ativo físico (descrição em Documentos)',
    receiveAssetId: usd, volumeText: '10 unidades', referenceAmount: '1000000.037777', referenceAssetId: usd, grade: '25/15',
    conditions: ['Entrega imediata', 'Apresentação de CIS', 'Carteiras USDT para compliance', 'Liberação após validação'],
  }, { isDemo: true });
  // As linhas-modelo da grade 25/15 já reproduzem 1500 + 333 + 333 + 111 + 111 + 111 + resíduo 1.
  await fill(ctx, d2.dealId, [['VENDEDOR', 1, 'vend'], ['GRUPO_VENDA', 1, 'gv'], ['INTERMEDIACAO_VENDA', 1, 'iv'], ['INTERMEDIACAO_COMPRA', 1, 'ic'], ['GRUPO_COMPRA', 1, 'gc'], ['COMPRADOR', 1, 'comp']], ids);
  await submitForSignatures(ctx, ids.pm01, d2.dealId);
  for (const k of ['vend', 'gv', 'iv', 'pm01', 'ic', 'gc', 'comp']) await signAs(ctx, k, ids[k], d2.dealId);

  // ---------------- DEMO 3 — OFERTA ÚNICA — Ativo físico → USDT — Grade 12/8 (PENDING 5/6, dois Pay Masters)
  const d3 = await createOffer(ctx, ids.pm01, {
    kind: 'UNICA', title: 'Lote físico de 12 unidades', deliverAssetId: 'PHYSICAL:asset', deliverDescription: 'Ativo físico (12 unidades)',
    receiveAssetId: usd, volumeText: '12 unidades', referenceAmount: '12000000.000001', referenceAssetId: usd, grade: '12/8',
    conditions: [
      'Retirada parcial exige saldo compatível na carteira pagadora',
      'Retirada integral exige saldo dos 12',
      'Avanço condicionado à validação de CIS, carteira pagadora, documentação e compliance',
    ],
    roles: ['VENDEDOR', 'GRUPO_VENDA', 'GRUPO_COMPRA', 'COMPRADOR'], payMasters: 2,
    validUntil: new Date(now + 5 * day).toISOString(),
  }, { isDemo: true });
  await setLines(ctx, d3.dealId, [
    { lineKey: 'pagador', label: 'Pagador', roleKey: 'COMPRADOR', bps: 800, kind: 'PAGADOR' },
    { lineKey: 'venda_fechada', label: 'Venda fechada', roleKey: 'GRUPO_VENDA', bps: 200, kind: 'GRUPO_VENDA' },
    { lineKey: 'compra_intermediarios', label: 'Compra e intermediários', roleKey: 'GRUPO_COMPRA', bps: 200, kind: 'GRUPO_COMPRA' },
  ]);
  await fill(ctx, d3.dealId, [['PAY_MASTER', 2, 'pm02'], ['VENDEDOR', 1, 'vend'], ['GRUPO_VENDA', 1, 'gv'], ['GRUPO_COMPRA', 1, 'gc'], ['COMPRADOR', 1, 'comp']], ids);
  await submitForSignatures(ctx, ids.pm01, d3.dealId);
  for (const k of ['vend', 'gv', 'pm01', 'pm02', 'gc']) await signAs(ctx, k, ids[k], d3.dealId);
  return true;
}

export function personaDirectory() {
  return PERSONAS.map((p) => ({ key: p.key, name: p.name, hint: p.hint, address: demoAddress(p.key) }));
}
