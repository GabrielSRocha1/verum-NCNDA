import type { Queryable } from '../db.ts';
import { dbErrorCode } from '../db.ts';
import { sha256Hex, canonicalJson } from '../lib/crypto.ts';
import { HttpError, badRequest, conflict, forbidden, notFound, audit } from '../lib/common.ts';
import {
  parseGrade, splitBps, residualTarget, validateLines, parseUnits, formatUnits, formatBps,
  RESIDUAL_POLICIES, LINE_KINDS, type AllocationLine, type ResidualPolicy, type LineKind,
} from '../lib/bps.ts';
import { issueChallenge, consumeChallenge, type Ctx } from './auth.ts';
import { loadLines, assertDealAdmin, assertDealMember, currentVersion, roleLabel, ROLE_KEYS, settlementView } from './deals.ts';

// ================================================================= linhas-modelo a partir da grade
/**
 * Pagador = Y. O restante (X − Y) é dividido igualmente entre Grupo Venda, Grupo Compra e Intermediação
 * (o resto da divisão vai para a Intermediação). A Intermediação é dividida entre intermediário de venda,
 * Pay Master (ligação) e intermediário de compra; o resto vira linha explícita "Resíduo de divisão".
 * Reproduz exatamente o exemplo 25/15 → 1500 + 333 + 333 + (111+111+111+1).
 */
export function templateLines(totalBps: number, payerBps: number, roles: Set<string>, policy: ResidualPolicy): AllocationLine[] {
  const lines: AllocationLine[] = [];
  const payerRole = roles.has('COMPRADOR') ? 'COMPRADOR' : 'PAY_MASTER';
  if (payerBps > 0) lines.push({ lineKey: 'pagador', label: 'Pagador', roleKey: payerRole, roleSeq: 1, bps: payerBps, kind: 'PAGADOR' });
  const rest = totalBps - payerBps;
  if (rest === 0) return lines;
  const intermRoles = ['INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA'].filter((r) => r === 'PAY_MASTER' || roles.has(r));
  const buckets: { key: string; label: string; role: string | null; kind: LineKind }[] = [];
  if (roles.has('GRUPO_VENDA')) buckets.push({ key: 'grupo_venda', label: 'Grupo Venda', role: 'GRUPO_VENDA', kind: 'GRUPO_VENDA' });
  if (roles.has('GRUPO_COMPRA')) buckets.push({ key: 'grupo_compra', label: 'Grupo Compra', role: 'GRUPO_COMPRA', kind: 'GRUPO_COMPRA' });
  buckets.push({ key: 'intermediacao', label: 'Intermediação', role: null, kind: 'INTERMEDIACAO' });
  const { shares, residual } = splitBps(rest, buckets.length);
  shares[shares.length - 1] += residual;
  buckets.forEach((b, i) => {
    if (b.kind !== 'INTERMEDIACAO') {
      lines.push({ lineKey: b.key, label: b.label, roleKey: b.role, roleSeq: 1, bps: shares[i], kind: b.kind });
      return;
    }
    const sp = splitBps(shares[i], intermRoles.length);
    intermRoles.forEach((r, j) => lines.push({
      lineKey: `intermediacao_${j + 1}`, label: `Intermediação — ${r === 'PAY_MASTER' ? 'Ligação' : r === 'INTERMEDIACAO_VENDA' ? 'Venda' : 'Compra'}`,
      roleKey: r, roleSeq: 1, bps: sp.shares[j], kind: 'INTERMEDIACAO',
    }));
    if (sp.residual > 0) {
      const t = residualTarget(policy, lines);
      lines.push({ lineKey: 'intermediacao_residuo', label: 'Resíduo de divisão', roleKey: t.roleKey, roleSeq: t.roleSeq, bps: sp.residual, kind: 'RESIDUO' });
    }
  });
  return lines;
}

async function insertLines(q: Queryable, versionId: string, lines: AllocationLine[]) {
  let pos = 0;
  for (const l of lines) {
    await q.query(`INSERT INTO allocation_lines (version_id, position, line_key, label, role_key, role_seq, bps, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [versionId, pos++, l.lineKey, l.label, l.roleKey, l.roleSeq, l.bps, l.kind]);
  }
}

// ================================================================= hash dos termos
export async function computeTermsHash(q: Queryable, dealId: string, versionId: string): Promise<string> {
  const { rows: [o] } = await q.query<any>(
    `SELECT d.code, o.kind, o.title, o.volume_text, o.reference_amount, o.reference_asset_id, o.grade_total_bps, o.grade_payer_bps, o.conditions, o.valid_until
       FROM deals d JOIN offers o ON o.id = d.offer_id WHERE d.id = $1`, [dealId]);
  const { rows: legs } = await q.query<any>(`SELECT side, asset_id, leg_type, description FROM offer_legs ol JOIN deals d ON d.offer_id = ol.offer_id WHERE d.id = $1 ORDER BY side`, [dealId]);
  const { rows: [v] } = await q.query<any>(`SELECT version_no, residual_policy, grade_total_bps FROM partnership_versions WHERE id = $1`, [versionId]);
  const { rows: parts } = await q.query<any>(
    `SELECT pp.role_key, pp.seq, w.address FROM partnership_participants pp LEFT JOIN wallets w ON w.id = pp.wallet_id
      WHERE pp.version_id = $1 ORDER BY pp.role_key, pp.seq`, [versionId]);
  const lines = await loadLines(q, versionId);
  return sha256Hex(canonicalJson({
    schema: 'verum-ncnda/terms/v1',
    deal: o.code, version: v.version_no, kind: o.kind, title: o.title, volume: o.volume_text,
    reference: o.reference_amount ? { amount: String(o.reference_amount), asset: o.reference_asset_id } : null,
    grade: { total_bps: o.grade_total_bps, payer_bps: o.grade_payer_bps }, conditions: o.conditions,
    valid_until: o.valid_until ? new Date(o.valid_until).toISOString() : null,
    legs: legs.map((l) => ({ side: l.side, asset: l.asset_id, leg_type: l.leg_type, description: l.description })),
    residual_policy: v.residual_policy,
    participants: parts.map((p) => ({ role: p.role_key, seq: p.seq, wallet: p.address })),
    lines: lines.map((l) => ({ key: l.lineKey, label: l.label, role: l.roleKey, seq: l.roleSeq, bps: l.bps, kind: l.kind })),
  }));
}

// ================================================================= criação de oferta (ÚNICA / PERMANENTE)
export interface CreateOfferInput {
  kind: 'UNICA' | 'PERMANENTE';
  title: string;
  businessId?: string;
  businessName?: string;
  businessTagline?: string;
  deliverAssetId: string;
  receiveAssetId: string;
  deliverDescription?: string;
  receiveDescription?: string;
  volumeText: string;
  referenceAmount?: string;
  referenceAssetId?: string;
  grade: string;
  conditions?: string[];
  validUntil?: string;
  roles?: string[];
  payMasters?: number;
  residualPolicy?: ResidualPolicy;
}

export async function createOffer(ctx: Ctx, userId: string, input: CreateOfferInput, opts: { isDemo?: boolean } = {}) {
  // Quem entrou por link de visualização recebeu leitura de UMA operação, não um lugar na
  // plataforma: não abre mesa própria. Concluir um convite promove a conta e libera isto.
  const { rows: [autor] } = await ctx.db.query<any>(`SELECT origin FROM users WHERE id = $1`, [userId]);
  if (autor?.origin === 'VIEW_LINK') {
    throw new HttpError(403, 'VIEWER_ONLY', 'Sua conta foi criada por um link de visualização e só permite ler a operação compartilhada. Para abrir uma mesa, é preciso entrar por convite.');
  }
  const grade = (() => { try { return parseGrade(input.grade); } catch (e) { throw badRequest('GRADE_INVALID', (e as Error).message); } })();
  const conditions = (input.conditions ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (conditions.length > 5) throw badRequest('CONDITIONS_TOO_MANY', 'Máximo de 5 linhas de condições.');
  if (conditions.some((c) => c.length > 120)) throw badRequest('CONDITION_TOO_LONG', 'Cada condição deve ter até 120 caracteres.');
  const policy = input.residualPolicy ?? 'TO_PAY_MASTER';
  if (!RESIDUAL_POLICIES.includes(policy)) throw badRequest('POLICY_INVALID', 'Política de resíduo inválida.');
  const deliver = ctx.assets.byId(input.deliverAssetId);
  const receive = ctx.assets.byId(input.receiveAssetId);
  if (!deliver || !receive) throw badRequest('ASSET_UNKNOWN', 'Ativo fora do Asset Registry.');
  for (const a of [deliver, receive]) {
    if (a.legType === 'ONCHAIN') {
      const chk = ctx.assets.validateOnchain({ symbol: a.symbol, network: a.network, mint: a.mint, decimals: a.decimals });
      if (!chk.ok) throw badRequest('ASSET_REJECTED', `Ativo ${a.id} recusado: ${chk.reason}`);
    } else if (a.status !== 'ACTIVE') throw badRequest('ASSET_REJECTED', `Ativo ${a.id} desabilitado.`);
  }
  if (deliver.id === receive.id) throw badRequest('DIRECTION_INVALID', 'Ativo ofertado e recebido devem ser diferentes.');
  let refAmount: bigint | null = null;
  let refAsset = null as ReturnType<typeof ctx.assets.byId>;
  if (input.referenceAmount) {
    refAsset = ctx.assets.byId(input.referenceAssetId ?? '');
    if (!refAsset || refAsset.legType !== 'ONCHAIN') throw badRequest('REFERENCE_ASSET_INVALID', 'Valor de referência exige ativo on-chain do registro.');
    try { refAmount = parseUnits(input.referenceAmount, refAsset.decimals); } catch (e) { throw badRequest('REFERENCE_INVALID', (e as Error).message); }
    if (refAmount <= 0n) throw badRequest('REFERENCE_INVALID', 'Valor de referência deve ser positivo.');
  }
  const payMasters = input.payMasters ?? 1;
  if (![1, 2].includes(payMasters)) throw badRequest('PAY_MASTERS_INVALID', 'Use 1 ou 2 Pay Masters.');
  const roles = new Set((input.roles ?? ['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR']).filter((r) => r !== 'PAY_MASTER'));
  for (const r of roles) if (!ROLE_KEYS.includes(r)) throw badRequest('ROLE_INVALID', `Função inválida: ${r}`);
  roles.add('PAY_MASTER');

  return ctx.db.tx(async (q) => {
    const now = ctx.cfg.now();
    const { rows: [creatorWallet] } = await q.query<any>(`SELECT id FROM wallets WHERE user_id = $1 AND network = $2`, [userId, ctx.sig.network]);
    if (!creatorWallet) throw forbidden('Conecte a Verum Wallet para criar ofertas.');
    let businessId: string | null = null;
    let inherit: { versionId: string; dealId: string } | null = null;
    if (input.kind === 'PERMANENTE') {
      if (input.businessId) {
        const { rows: [b] } = await q.query<any>(`SELECT id, admin_user_id FROM businesses WHERE id = $1`, [input.businessId]);
        if (!b) throw notFound('Negócio não encontrado.');
        if (b.admin_user_id !== userId) throw forbidden('Só o admin do Negócio cria novas ofertas nele.');
        businessId = b.id;
        const { rows: [src] } = await q.query<any>(
          `SELECT pv.id AS version_id, d.id AS deal_id FROM deals d JOIN offers o ON o.id = d.offer_id
             JOIN partnerships p ON p.deal_id = d.id JOIN partnership_versions pv ON pv.partnership_id = p.id
            WHERE o.business_id = $1 AND pv.status IN ('LOCKED','FUNDED','EXECUTING','SETTLED')
            ORDER BY pv.locked_at DESC NULLS LAST, pv.created_at DESC LIMIT 1`, [b.id]);
        if (src) inherit = { versionId: src.version_id, dealId: src.deal_id };
      } else {
        const name = String(input.businessName ?? '').trim();
        if (name.length < 2 || name.length > 80) throw badRequest('BUSINESS_NAME', 'Informe o nome do Negócio (2 a 80 caracteres).');
        const { rows: [b] } = await q.query<any>(`INSERT INTO businesses (name, tagline, admin_user_id, is_demo, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [name, input.businessTagline?.trim() || null, userId, !!opts.isDemo, now.toISOString()]);
        businessId = b.id;
        await audit(q, { at: now, userId, action: 'BUSINESS_CREATED', entity: 'business', entityId: b.id });
      }
    }
    const { rows: [offer] } = await q.query<any>(
      `INSERT INTO offers (kind, business_id, title, volume_text, reference_amount, reference_asset_id, grade_total_bps, grade_payer_bps, conditions, valid_until, is_demo, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [input.kind, businessId, input.title.trim(), input.volumeText.trim(), refAmount?.toString() ?? null, refAsset?.id ?? null,
        grade.totalBps, grade.payerBps, conditions, input.validUntil ?? null, !!opts.isDemo, userId, now.toISOString()]);
    await q.query(`INSERT INTO offer_legs (offer_id, side, asset_id, leg_type, description) VALUES ($1,'ENTREGA',$2,$3,$4), ($1,'RECEBIMENTO',$5,$6,$7)`,
      [offer.id, deliver.id, deliver.legType, input.deliverDescription?.trim() || null, receive.id, receive.legType, input.receiveDescription?.trim() || null]);
    const { rows: [{ n }] } = await q.query<any>(`SELECT nextval('deal_code_seq') AS n`);
    const code = `OTC-${String(n).padStart(4, '0')}`;
    const { rows: [deal] } = await q.query<any>(`INSERT INTO deals (code, offer_id, admin_user_id, is_demo, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [code, offer.id, userId, !!opts.isDemo, now.toISOString()]);
    const { rows: [p] } = await q.query<any>(`INSERT INTO partnerships (deal_id) VALUES ($1) RETURNING id`, [deal.id]);
    const { rows: [v] } = await q.query<any>(
      `INSERT INTO partnership_versions (partnership_id, version_no, residual_policy, grade_total_bps, created_by, created_at) VALUES ($1,1,$2,$3,$4,$5) RETURNING id`,
      [p.id, policy, grade.totalBps, userId, now.toISOString()]);
    await q.query(`UPDATE partnerships SET current_version_id = $2 WHERE id = $1`, [p.id, v.id]);
    // O criador (Pay Master 01 / admin) é membro da operação desde a criação.
    await q.query(`INSERT INTO deal_participants (deal_id, user_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [deal.id, userId, now.toISOString()]);

    if (inherit) {
      // Parceria permanente: herda parceiros e papéis da última versão travada do Negócio.
      const { rows: parts } = await q.query<any>(`SELECT role_key, seq, user_id, wallet_id FROM partnership_participants WHERE version_id = $1`, [inherit.versionId]);
      for (const pp of parts) {
        await q.query(`INSERT INTO partnership_participants (version_id, role_key, seq, user_id, wallet_id) VALUES ($1,$2,$3,$4,$5)`, [v.id, pp.role_key, pp.seq, pp.user_id, pp.wallet_id]);
        if (pp.user_id && pp.user_id !== userId) {
          await q.query(`INSERT INTO deal_participants (deal_id, user_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [deal.id, pp.user_id, now.toISOString()]);
        }
      }
      const { rows: [src] } = await q.query<any>(`SELECT grade_total_bps, residual_policy FROM partnership_versions WHERE id = $1`, [inherit.versionId]);
      const srcLines = await loadLines(q, inherit.versionId);
      const inheritedRoles = new Set(parts.map((x) => x.role_key));
      await insertLines(q, v.id, src.grade_total_bps === grade.totalBps && src.residual_policy === policy
        ? srcLines : templateLines(grade.totalBps, grade.payerBps, inheritedRoles, policy));
    } else {
      for (let s = 1; s <= payMasters; s++) {
        await q.query(`INSERT INTO partnership_participants (version_id, role_key, seq, user_id, wallet_id) VALUES ($1,'PAY_MASTER',$2,$3,$4)`,
          [v.id, s, s === 1 ? userId : null, s === 1 ? creatorWallet.id : null]);
      }
      for (const r of roles) {
        if (r === 'PAY_MASTER') continue;
        await q.query(`INSERT INTO partnership_participants (version_id, role_key, seq) VALUES ($1,$2,1)`, [v.id, r]);
      }
      await insertLines(q, v.id, templateLines(grade.totalBps, grade.payerBps, roles, policy));
    }
    await audit(q, { at: now, userId, action: 'OFFER_CREATED', entity: 'offer', entityId: offer.id, dealId: deal.id, newValue: { kind: input.kind, grade_total_bps: grade.totalBps, grade_payer_bps: grade.payerBps } });
    await audit(q, { at: now, userId, action: 'DEAL_CREATED', entity: 'deal', entityId: deal.id, dealId: deal.id, newValue: { code, inherited_from: inherit?.dealId ?? null } });
    return { dealId: deal.id as string, code, versionId: v.id as string, inherited: !!inherit };
  });
}

// ================================================================= edição em DRAFT
export interface LineInput { lineKey: string; label: string; roleKey: string | null; roleSeq?: number; bps: number; kind: LineKind }

export async function updateLines(ctx: Ctx, adminId: string, dealId: string, input: { lines: LineInput[]; residualPolicy?: ResidualPolicy }) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'DRAFT') throw conflict('VERSION_LOCKED', 'Parceria fora de DRAFT: alterações só em uma nova versão.');
    const lines: AllocationLine[] = input.lines.map((l) => ({
      lineKey: String(l.lineKey), label: String(l.label).trim(), roleKey: l.roleKey ?? null, roleSeq: l.roleSeq ?? 1, bps: l.bps, kind: l.kind,
    }));
    if (lines.length === 0 || lines.length > 30) throw badRequest('LINES_INVALID', 'Informe de 1 a 30 linhas.');
    const { rows: slots } = await q.query<any>(`SELECT role_key, seq FROM partnership_participants WHERE version_id = $1`, [v.id]);
    const slotKeys = new Set(slots.map((s) => `${s.role_key}#${s.seq}`));
    for (const l of lines) {
      if (!LINE_KINDS.includes(l.kind)) throw badRequest('LINES_INVALID', `Tipo inválido: ${l.kind}`);
      if (!Number.isSafeInteger(l.bps) || l.bps < 0 || l.bps > 10000) throw badRequest('LINES_INVALID', 'bps deve ser inteiro entre 0 e 10000.');
      if (!l.label || l.label.length > 60) throw badRequest('LINES_INVALID', 'Rótulo da linha inválido.');
      if (l.roleKey && !slotKeys.has(`${l.roleKey}#${l.roleSeq}`)) throw badRequest('LINES_INVALID', `A linha "${l.label}" aponta para uma função sem cadeira: ${roleLabel(l.roleKey, l.roleSeq)}.`);
    }
    const policy = input.residualPolicy ?? v.residual_policy;
    if (!RESIDUAL_POLICIES.includes(policy)) throw badRequest('POLICY_INVALID', 'Política de resíduo inválida.');
    const validation = validateLines(lines, v.grade_total_bps);
    if (validation.errors.some((e) => !e.startsWith('Soma'))) throw badRequest('LINES_INVALID', validation.errors.join(' '));
    // Convites vivos têm percentual travado: alterar a fatia daquela função exige revogar antes.
    const { rows: live } = await q.query<any>(`SELECT role_id, role_seq, bps FROM invitations WHERE partnership_version_id = $1 AND status IN ('ATIVO','ABERTO')`, [v.id]);
    const newBps = new Map<string, number>();
    for (const l of lines) if (l.roleKey) newBps.set(`${l.roleKey}#${l.roleSeq}`, (newBps.get(`${l.roleKey}#${l.roleSeq}`) ?? 0) + l.bps);
    for (const i of live) {
      if ((newBps.get(`${i.role_id}#${i.role_seq}`) ?? 0) !== i.bps) {
        throw conflict('LIVE_INVITE_BPS', `${roleLabel(i.role_id, i.role_seq)} tem convite ativo com ${formatBps(i.bps)} travado. Revogue o convite antes de mudar esse percentual.`);
      }
    }
    const old = await loadLines(q, v.id);
    await q.query(`DELETE FROM allocation_lines WHERE version_id = $1`, [v.id]);
    await insertLines(q, v.id, lines);
    if (policy !== v.residual_policy) await q.query(`UPDATE partnership_versions SET residual_policy = $2 WHERE id = $1`, [v.id, policy]);
    await audit(q, { at: ctx.cfg.now(), userId: adminId, action: 'ALLOCATION_CHANGED', entity: 'partnership_version', entityId: v.id, dealId,
      oldValue: { residual_policy: v.residual_policy, lines: old }, newValue: { residual_policy: policy, lines } });
    return { validation };
  });
}

export async function addSlot(ctx: Ctx, adminId: string, dealId: string, roleKey: string) {
  if (!ROLE_KEYS.includes(roleKey)) throw badRequest('ROLE_INVALID', 'Função inválida.');
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'DRAFT') throw conflict('VERSION_LOCKED', 'Participantes só mudam em DRAFT.');
    const { rows: [m] } = await q.query<any>(`SELECT COALESCE(MAX(seq),0)::int AS s FROM partnership_participants WHERE version_id = $1 AND role_key = $2`, [v.id, roleKey]);
    if (roleKey !== 'PAY_MASTER' && m.s >= 1) throw conflict('ROLE_EXISTS', 'Essa função já tem cadeira nesta versão.');
    if (roleKey === 'PAY_MASTER' && m.s >= 2) throw conflict('ROLE_EXISTS', 'Máximo de 2 Pay Masters.');
    const { rows: [p] } = await q.query<any>(`INSERT INTO partnership_participants (version_id, role_key, seq) VALUES ($1,$2,$3) RETURNING id`, [v.id, roleKey, m.s + 1]);
    await audit(q, { at: ctx.cfg.now(), userId: adminId, action: 'ALLOCATION_CHANGED', entity: 'partnership_participant', entityId: p.id, dealId, newValue: { slot_added: roleKey, seq: m.s + 1 } });
    return { participantId: p.id };
  });
}

export async function removeSlot(ctx: Ctx, adminId: string, dealId: string, participantId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'DRAFT') throw conflict('VERSION_LOCKED', 'Participantes só mudam em DRAFT.');
    const { rows: [p] } = await q.query<any>(`SELECT * FROM partnership_participants WHERE id = $1 AND version_id = $2`, [participantId, v.id]);
    if (!p) throw notFound('Cadeira não encontrada.');
    if (p.role_key === 'PAY_MASTER' && p.seq === 1) throw conflict('SLOT_REQUIRED', 'O Pay Master 01 é obrigatório.');
    if (p.wallet_id) throw conflict('SLOT_FILLED', 'Cadeira ocupada: crie nova versão para trocar o participante.');
    const lines = await loadLines(q, v.id);
    if (lines.some((l) => l.roleKey === p.role_key && l.roleSeq === p.seq)) throw conflict('SLOT_HAS_LINES', 'Remova ou redirecione as linhas de comissão dessa função antes.');
    const { rows: inv } = await q.query<any>(`SELECT 1 FROM invitations WHERE participant_id = $1`, [p.id]);
    if (inv.length) throw conflict('SLOT_HAS_INVITES', 'Essa cadeira tem histórico de convites; mantenha-a ou crie nova versão.');
    await q.query(`DELETE FROM partnership_participants WHERE id = $1`, [p.id]);
    await audit(q, { at: ctx.cfg.now(), userId: adminId, action: 'ALLOCATION_CHANGED', entity: 'partnership_participant', entityId: p.id, dealId, oldValue: { slot_removed: p.role_key, seq: p.seq } });
    return { ok: true };
  });
}

function mapDbError(e: unknown): never {
  const code = dbErrorCode(e);
  const msg = (e as Error).message;
  if (code === 'BPS_SUM_MISMATCH') throw badRequest(code, 'A soma das linhas não fecha com o deságio total da grade. A parceria não pode sair de DRAFT.');
  if (code === 'PARTICIPANTS_INCOMPLETE') throw badRequest(code, 'Há funções sem parceiro cadastrado. Gere os convites e aguarde a conclusão.');
  if (code === 'LOCKED_VERSION' || code === 'VERSION_IMMUTABLE') throw conflict('VERSION_LOCKED', 'Parceria travada: qualquer mudança exige nova versão.');
  if (code === 'INVALID_TRANSITION' || code === 'SIGNATURES_INCOMPLETE') throw conflict(code, msg);
  throw e;
}

export async function submitForSignatures(ctx: Ctx, adminId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'DRAFT') throw conflict('INVALID_TRANSITION', 'Só versões em DRAFT podem ir para assinatura.');
    const { rows: live } = await q.query(`SELECT 1 FROM invitations WHERE partnership_version_id = $1 AND status IN ('ATIVO','ABERTO')`, [v.id]);
    if (live.length) throw conflict('LIVE_INVITES', 'Existem convites em aberto nesta versão. Aguarde a conclusão ou revogue.');
    const hash = await computeTermsHash(q, dealId, v.id);
    try {
      await q.query(`UPDATE partnership_versions SET terms_hash = $2 WHERE id = $1`, [v.id, hash]);
      await q.query(`UPDATE partnership_versions SET status = 'PENDING_SIGNATURES' WHERE id = $1`, [v.id]);
    } catch (e) { mapDbError(e); }
    await audit(q, { at: ctx.cfg.now(), userId: adminId, action: 'VERSION_SUBMITTED', entity: 'partnership_version', entityId: v.id, dealId, oldValue: { status: 'DRAFT' }, newValue: { status: 'PENDING_SIGNATURES', terms_hash: hash } });
    return { status: 'PENDING_SIGNATURES', termsHash: hash };
  });
}

/** Volta para DRAFT: invalida todas as assinaturas anteriores (mudança de termos). */
export async function reopenDraft(ctx: Ctx, adminId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'PENDING_SIGNATURES') throw conflict('INVALID_TRANSITION', 'Só versões aguardando aceite podem voltar para DRAFT. Parcerias travadas exigem nova versão.');
    const now = ctx.cfg.now();
    const { rows: inv } = await q.query(`UPDATE signatures SET invalidated_at = $2 WHERE version_id = $1 AND invalidated_at IS NULL RETURNING id`, [v.id, now.toISOString()]);
    await q.query(`UPDATE partnership_versions SET status = 'DRAFT' WHERE id = $1`, [v.id]);
    await audit(q, { at: now, userId: adminId, action: 'SIGNATURES_INVALIDATED', entity: 'partnership_version', entityId: v.id, dealId, newValue: { invalidated: inv.length } });
    await audit(q, { at: now, userId: adminId, action: 'VERSION_REOPENED', entity: 'partnership_version', entityId: v.id, dealId, oldValue: { status: 'PENDING_SIGNATURES' }, newValue: { status: 'DRAFT' } });
    return { status: 'DRAFT', invalidated: inv.length };
  });
}

/** Parceria travada: cria NOVA VERSÃO em DRAFT copiando parceiros e linhas. Exige novos aceites. */
export async function createNewVersion(ctx: Ctx, adminId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'LOCKED') throw conflict('INVALID_TRANSITION', v.status === 'DRAFT' ? 'A versão atual já está em DRAFT.' : 'Nova versão só a partir de parceria LOCKED (antes do financiamento).');
    const now = ctx.cfg.now();
    const { rows: [nv] } = await q.query<any>(
      `INSERT INTO partnership_versions (partnership_id, version_no, residual_policy, grade_total_bps, supersedes_id, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version_no`,
      [v.partnership_id, v.version_no + 1, v.residual_policy, v.grade_total_bps, v.id, adminId, now.toISOString()]);
    const { rows: parts } = await q.query<any>(`SELECT role_key, seq, user_id, wallet_id FROM partnership_participants WHERE version_id = $1`, [v.id]);
    for (const p of parts) await q.query(`INSERT INTO partnership_participants (version_id, role_key, seq, user_id, wallet_id) VALUES ($1,$2,$3,$4,$5)`, [nv.id, p.role_key, p.seq, p.user_id, p.wallet_id]);
    await insertLines(q, nv.id, await loadLines(q, v.id));
    await q.query(`UPDATE partnership_versions SET superseded_by_id = $2 WHERE id = $1`, [v.id, nv.id]);
    await q.query(`UPDATE partnerships SET current_version_id = $2 WHERE id = $1`, [v.partnership_id, nv.id]);
    await audit(q, { at: now, userId: adminId, action: 'VERSION_CREATED', entity: 'partnership_version', entityId: nv.id, dealId, oldValue: { version_no: v.version_no }, newValue: { version_no: nv.version_no, status: 'DRAFT' } });
    return { versionId: nv.id, versionNo: nv.version_no };
  });
}

/** Substitui a carteira/participante de uma cadeira — somente em DRAFT (nova versão). Esvazia a cadeira para novo convite. */
export async function vacateSlot(ctx: Ctx, adminId: string, dealId: string, participantId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'DRAFT') throw conflict('VERSION_LOCKED', 'Parceria travada: troca de carteira/participante só em nova versão.');
    const { rows: [p] } = await q.query<any>(`SELECT * FROM partnership_participants WHERE id = $1 AND version_id = $2`, [participantId, v.id]);
    if (!p) throw notFound('Cadeira não encontrada.');
    if (p.role_key === 'PAY_MASTER' && p.seq === 1) throw conflict('SLOT_REQUIRED', 'O Pay Master 01 (admin) não pode ser removido.');
    await q.query(`UPDATE partnership_participants SET user_id = NULL, wallet_id = NULL WHERE id = $1`, [p.id]);
    await audit(q, { at: ctx.cfg.now(), userId: adminId, action: 'ALLOCATION_CHANGED', entity: 'partnership_participant', entityId: p.id, dealId, oldValue: { filled: true }, newValue: { filled: false } });
    return { ok: true };
  });
}

// ================================================================= assinatura da parceria (mensagem, sem fundos)
export async function agreementChallenge(ctx: Ctx, userId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const v = await currentVersion(q, dealId);
    if (v.status !== 'PENDING_SIGNATURES') throw conflict('NOT_PENDING', 'A parceria não está aguardando aceites.');
    const { rows: [p] } = await q.query<any>(
      `SELECT pp.id, pp.role_key, pp.seq, w.address FROM partnership_participants pp JOIN wallets w ON w.id = pp.wallet_id WHERE pp.version_id = $1 AND pp.user_id = $2`, [v.id, userId]);
    if (!p) throw forbidden('Você não é participante desta versão.');
    const { rows: [d] } = await q.query<any>(`SELECT code FROM deals WHERE id = $1`, [dealId]);
    return issueChallenge(q, ctx, {
      purpose: 'AGREEMENT', address: p.address,
      context: { 'Operação': d.code, 'Versão': String(v.version_no), 'Hash dos termos': v.terms_hash, 'Função': roleLabel(p.role_key, p.seq), 'Participante': p.id },
    });
  });
}

export async function signAgreement(ctx: Ctx, userId: string, dealId: string, input: { challengeId: string; nonce: string; signature: string }) {
  let failure: HttpError | null = null;
  const out = await ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const v = await currentVersion(q, dealId, true);
    let ch;
    try { ch = await consumeChallenge(q, ctx, { ...input, purpose: 'AGREEMENT' }); } catch (e) { failure = e as HttpError; return null; }
    if (v.status !== 'PENDING_SIGNATURES' || ch.context['Hash dos termos'] !== v.terms_hash) {
      failure = conflict('TERMS_CHANGED', 'Os termos mudaram desde o desafio. Revise e assine novamente.'); return null;
    }
    const { rows: [p] } = await q.query<any>(
      `SELECT pp.id, w.address FROM partnership_participants pp JOIN wallets w ON w.id = pp.wallet_id WHERE pp.version_id = $1 AND pp.user_id = $2`, [v.id, userId]);
    if (!p || p.id !== ch.context['Participante'] || p.address !== ch.wallet_address) { failure = forbidden('Assinatura de carteira que não ocupa esta função.'); return null; }
    const now = ctx.cfg.now();
    try {
      await q.query(`INSERT INTO signatures (kind, version_id, participant_id, user_id, wallet_address, terms_hash, message, signature, created_at)
                     VALUES ('AGREEMENT',$1,$2,$3,$4,$5,$6,$7,$8)`, [v.id, p.id, userId, ch.wallet_address, v.terms_hash, ch.message, input.signature, now.toISOString()]);
    } catch (e) {
      if (/signatures_one_valid_agreement/.test((e as Error).message)) { failure = conflict('ALREADY_SIGNED', 'Você já assinou esta versão.'); return null; }
      throw e;
    }
    await audit(q, { at: now, userId, action: 'AGREEMENT_SIGNED', entity: 'partnership_version', entityId: v.id, dealId, wallet: ch.wallet_address, newValue: { terms_hash: v.terms_hash, participant_id: p.id } });
    const { rows: [c] } = await q.query<any>(
      `SELECT (SELECT COUNT(*) FROM partnership_participants WHERE version_id = $1)::int AS n,
              (SELECT COUNT(*) FROM signatures WHERE version_id = $1 AND kind = 'AGREEMENT' AND invalidated_at IS NULL AND terms_hash = $2)::int AS k`, [v.id, v.terms_hash]);
    let locked = false;
    if (c.k === c.n) {
      try { await q.query(`UPDATE partnership_versions SET status = 'LOCKED', locked_at = $2 WHERE id = $1`, [v.id, now.toISOString()]); } catch (e) { mapDbError(e); }
      await audit(q, { at: now, userId, action: 'DEAL_LOCKED', entity: 'partnership_version', entityId: v.id, dealId, oldValue: { status: 'PENDING_SIGNATURES' }, newValue: { status: 'LOCKED', terms_hash: v.terms_hash } });
      locked = true;
    }
    return { k: c.k, n: c.n, locked, status: locked ? 'LOCKED' : 'PENDING_SIGNATURES' };
  });
  if (failure) throw failure;
  return out!;
}

// ================================================================= settlement (DEMO simulado)
async function settlementPlan(q: Queryable, ctx: Ctx, dealId: string, v: any) {
  const { rows: [o] } = await q.query<any>(`SELECT o.reference_amount, o.reference_asset_id FROM deals d JOIN offers o ON o.id = d.offer_id WHERE d.id = $1`, [dealId]);
  if (!o.reference_amount) throw badRequest('NO_REFERENCE', 'A oferta não tem valor de referência: não há base para distribuição.');
  const asset = ctx.assets.byId(o.reference_asset_id)!;
  return { asset, plan: { versionId: v.id, referenceAmount: BigInt(o.reference_amount), lines: await loadLines(q, v.id), gradeTotalBps: v.grade_total_bps, residualPolicy: v.residual_policy as ResidualPolicy } };
}

export async function settlementPreview(ctx: Ctx, userId: string | null, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const v = await currentVersion(q, dealId);
    const { asset, plan } = await settlementPlan(q, ctx, dealId, v);
    const dist = ctx.settlement.plan(plan);
    const fmt = (x: bigint) => `${formatUnits(x, asset.decimals)} ${asset.symbol}`;
    return {
      adapter: ctx.settlement.id, demo: ctx.settlement.demo, protectedByContract: ctx.settlement.protectedByContract,
      referenceLabel: fmt(dist.referenceAmount), poolLabel: fmt(dist.poolAmount), residualLabel: fmt(dist.residualUnits),
      truncatedNumerator: dist.truncatedNumerator,
      lines: dist.lines.map((l) => ({ ...l, amount: l.amount.toString(), amountLabel: fmt(l.amount), bpsLabel: formatBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })),
    };
  });
}

/** AUTORIZAR LIQUIDAÇÃO: explica antes o que será autorizado. Em DEMO, simulação — nenhum fundo se move. */
export async function settlementChallenge(ctx: Ctx, adminId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId);
    if (v.status !== 'LOCKED') throw conflict('NOT_LOCKED', 'A liquidação exige parceria LOCKED.');
    const { asset, plan } = await settlementPlan(q, ctx, dealId, v);
    const dist = ctx.settlement.plan(plan);
    const { rows: [w] } = await q.query<any>(`SELECT address FROM wallets WHERE user_id = $1 AND network = $2`, [adminId, ctx.sig.network]);
    const { rows: [d] } = await q.query<any>(`SELECT code FROM deals WHERE id = $1`, [dealId]);
    return issueChallenge(q, ctx, {
      purpose: 'SETTLEMENT', address: w.address,
      context: {
        'Operação': d.code, 'Versão': String(v.version_no), 'Hash dos termos': v.terms_hash,
        'Modo': ctx.settlement.demo ? 'SIMULADO (DEMO) — nenhum fundo real é movimentado' : ctx.settlement.id,
        'Distribuição': `${formatUnits(dist.poolAmount, asset.decimals)} ${asset.symbol} em ${dist.lines.length} linhas, conforme bps travados`,
      },
    });
  });
}

export async function fundSettlement(ctx: Ctx, adminId: string, dealId: string, input: { challengeId: string; nonce: string; signature: string }) {
  let failure: HttpError | null = null;
  const out = await ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    let ch;
    try { ch = await consumeChallenge(q, ctx, { ...input, purpose: 'SETTLEMENT' }); } catch (e) { failure = e as HttpError; return null; }
    if (v.status !== 'LOCKED' || ch.context['Hash dos termos'] !== v.terms_hash) { failure = conflict('NOT_LOCKED', 'A liquidação exige parceria LOCKED com os mesmos termos.'); return null; }
    const { rows: [w] } = await q.query<any>(`SELECT address FROM wallets WHERE user_id = $1 AND network = $2`, [adminId, ctx.sig.network]);
    if (w.address !== ch.wallet_address) { failure = forbidden('Assinatura de outra carteira.'); return null; }
    const now = ctx.cfg.now();
    const { asset, plan } = await settlementPlan(q, ctx, dealId, v);
    const dist = ctx.settlement.plan(plan);
    const { rows: [sig] } = await q.query<any>(
      `INSERT INTO signatures (kind, version_id, user_id, wallet_address, terms_hash, message, signature, created_at) VALUES ('SETTLEMENT_AUTH',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.id, adminId, ch.wallet_address, v.terms_hash, ch.message, input.signature, now.toISOString()]);
    const linesJson = dist.lines.map((l) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq, bps: l.bps, kind: l.kind, amount: l.amount.toString() }));
    const { rows: [st] } = await q.query<any>(
      `INSERT INTO settlements (version_id, adapter, status, asset_id, reference_amount, pool_amount, residual_units, truncated_numerator, lines, authorization_sig_id, created_at)
       VALUES ($1,$2,'FUNDED',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.id, ctx.settlement.id, asset.id, dist.referenceAmount.toString(), dist.poolAmount.toString(), dist.residualUnits.toString(), dist.truncatedNumerator, JSON.stringify(linesJson), sig.id, now.toISOString()]);
    await q.query(`UPDATE partnership_versions SET status = 'FUNDED' WHERE id = $1`, [v.id]);
    await audit(q, { at: now, userId: adminId, action: 'SETTLEMENT_CREATED', entity: 'settlement', entityId: st.id, dealId, wallet: ch.wallet_address, newValue: { adapter: ctx.settlement.id, pool: dist.poolAmount.toString(), residual_units: dist.residualUnits.toString() } });
    await audit(q, { at: now, userId: adminId, action: 'SETTLEMENT_FUNDED', entity: 'partnership_version', entityId: v.id, dealId, oldValue: { status: 'LOCKED' }, newValue: { status: 'FUNDED', simulated: ctx.settlement.demo } });
    return { settlementId: st.id, status: 'FUNDED' };
  });
  if (failure) throw failure;
  return out!;
}

export async function executeSettlement(ctx: Ctx, adminId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const v = await currentVersion(q, dealId, true);
    if (v.status !== 'FUNDED') throw conflict('NOT_FUNDED', 'A execução exige settlement FUNDED.');
    const { rows: [st] } = await q.query<any>(`SELECT * FROM settlements WHERE version_id = $1 FOR UPDATE`, [v.id]);
    const { plan } = await settlementPlan(q, ctx, dealId, v);
    const result = ctx.settlement.execute(plan);
    // Confere que a execução reproduz exatamente o plano autorizado.
    const same = canonicalJson(result.distribution.lines.map((l) => [l.lineKey, l.amount.toString()])) === canonicalJson((st.lines as any[]).map((l) => [l.lineKey, l.amount]));
    if (!same) throw conflict('PLAN_MISMATCH', 'A execução divergiu do plano autorizado. Nada foi liquidado.');
    const now = ctx.cfg.now();
    await q.query(`UPDATE partnership_versions SET status = 'EXECUTING' WHERE id = $1`, [v.id]);
    await q.query(`UPDATE settlements SET status = 'EXECUTING' WHERE id = $1`, [st.id]);
    await audit(q, { at: now, userId: adminId, action: 'SETTLEMENT_EXECUTING', entity: 'settlement', entityId: st.id, dealId, newValue: { reference: result.reference } });
    await q.query(`UPDATE settlements SET status = 'SETTLED', settled_at = $2 WHERE id = $1`, [st.id, now.toISOString()]);
    await q.query(`UPDATE partnership_versions SET status = 'SETTLED' WHERE id = $1`, [v.id]);
    await audit(q, { at: now, userId: adminId, action: 'SETTLEMENT_SETTLED', entity: 'settlement', entityId: st.id, dealId, oldValue: { status: 'EXECUTING' }, newValue: { status: 'SETTLED', simulated: ctx.settlement.demo } });
    const { rows: [fresh] } = await q.query<any>(`SELECT * FROM settlements WHERE id = $1`, [st.id]);
    return settlementView(ctx, fresh);
  });
}

// ================================================================= documentos (versão + hash + aceite)
export async function addDocument(ctx: Ctx, adminId: string, dealId: string, input: { name: string; documentId?: string; mime: string; contentBase64: string; requiresAcceptance?: boolean }) {
  const content = Buffer.from(String(input.contentBase64 ?? ''), 'base64');
  if (content.length === 0 || content.length > 2 * 1024 * 1024) throw badRequest('DOC_SIZE', 'Documento vazio ou acima de 2 MB.');
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mime)) throw badRequest('DOC_MIME', 'Tipo de arquivo inválido.');
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, adminId);
    const now = ctx.cfg.now();
    let docId = input.documentId;
    if (docId) {
      const { rows: [d] } = await q.query<any>(`SELECT id FROM documents WHERE id = $1 AND deal_id = $2`, [docId, dealId]);
      if (!d) throw notFound('Documento não encontrado.');
    } else {
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 120) throw badRequest('DOC_NAME', 'Nome do documento inválido.');
      ({ rows: [{ id: docId }] } = await q.query<any>(`INSERT INTO documents (deal_id, name, created_by, created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [dealId, name, adminId, now.toISOString()]));
    }
    const { rows: [{ n }] } = await q.query<any>(`SELECT COALESCE(MAX(version_no),0)::int + 1 AS n FROM document_versions WHERE document_id = $1`, [docId]);
    const hash = sha256Hex(content);
    const { rows: [dv] } = await q.query<any>(
      `INSERT INTO document_versions (document_id, version_no, sha256, mime, size_bytes, content, requires_acceptance, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [docId, n, hash, input.mime, content.length, content, input.requiresAcceptance ?? true, adminId, now.toISOString()]);
    await audit(q, { at: now, userId: adminId, action: 'DOCUMENT_ADDED', entity: 'document_version', entityId: dv.id, dealId, newValue: { document_id: docId, version_no: n, sha256: hash } });
    return { documentId: docId, versionId: dv.id, versionNo: n, sha256: hash };
  });
}

export async function listDocuments(ctx: Ctx, userId: string | null, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const { rows } = await q.query<any>(
      `SELECT d.id, d.name, dv.id AS version_id, dv.version_no, dv.sha256, dv.mime, dv.size_bytes, dv.requires_acceptance, dv.created_at,
              (SELECT MAX(version_no) FROM document_versions x WHERE x.document_id = d.id) AS latest,
              COALESCE((SELECT json_agg(json_build_object('name', u.full_name, 'at', s.created_at)) FROM signatures s JOIN users u ON u.id = s.user_id
                         WHERE s.document_version_id = dv.id AND s.kind = 'DOCUMENT'), '[]'::json) AS accepted_by,
              EXISTS (SELECT 1 FROM signatures s WHERE s.document_version_id = dv.id AND s.user_id = $2 AND s.kind = 'DOCUMENT') AS i_accepted
         FROM documents d JOIN document_versions dv ON dv.document_id = d.id WHERE d.deal_id = $1 ORDER BY d.created_at, dv.version_no DESC`, [dealId, userId]);
    return rows.map((r) => ({
      documentId: r.id, name: r.name, versionId: r.version_id, versionNo: r.version_no, sha256: r.sha256, mime: r.mime, size: r.size_bytes,
      requiresAcceptance: r.requires_acceptance, createdAt: r.created_at, isLatest: r.version_no === r.latest,
      status: r.version_no !== r.latest ? 'SUBSTITUÍDO' : (r.requires_acceptance ? 'AGUARDANDO ACEITE' : 'INFORMATIVO'),
      acceptedBy: r.accepted_by, iAccepted: r.i_accepted,
    }));
  });
}

export async function documentContent(ctx: Ctx, userId: string | null, dealId: string, versionId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const { rows: [r] } = await q.query<any>(
      `SELECT dv.content, dv.mime, d.name, dv.version_no FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1 AND d.deal_id = $2`, [versionId, dealId]);
    if (!r) throw notFound('Documento não encontrado.');
    return { content: Buffer.from(r.content), mime: r.mime, filename: `documento-v${r.version_no}` };
  });
}

export async function documentChallenge(ctx: Ctx, userId: string, dealId: string, versionId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const { rows: [r] } = await q.query<any>(
      `SELECT dv.id, dv.sha256, dv.version_no, d.id AS doc_id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1 AND d.deal_id = $2`, [versionId, dealId]);
    if (!r) throw notFound('Documento não encontrado.');
    const { rows: [w] } = await q.query<any>(`SELECT address FROM wallets WHERE user_id = $1 AND network = $2`, [userId, ctx.sig.network]);
    if (!w) throw forbidden('Carteira não vinculada.');
    return issueChallenge(q, ctx, { purpose: 'DOCUMENT', address: w.address, context: { Documento: r.doc_id, 'Versão do documento': String(r.version_no), 'SHA-256': r.sha256, Registro: r.id } });
  });
}

export async function acceptDocument(ctx: Ctx, userId: string, dealId: string, versionId: string, input: { challengeId: string; nonce: string; signature: string }) {
  let failure: HttpError | null = null;
  const out = await ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    let ch;
    try { ch = await consumeChallenge(q, ctx, { ...input, purpose: 'DOCUMENT' }); } catch (e) { failure = e as HttpError; return null; }
    const { rows: [r] } = await q.query<any>(`SELECT dv.id, dv.sha256 FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1 AND d.deal_id = $2`, [versionId, dealId]);
    if (!r || ch.context['Registro'] !== r.id || ch.context['SHA-256'] !== r.sha256) { failure = conflict('DOC_CHANGED', 'O documento não corresponde ao desafio.'); return null; }
    const { rows: [w] } = await q.query<any>(`SELECT address FROM wallets WHERE user_id = $1 AND network = $2`, [userId, ctx.sig.network]);
    if (w.address !== ch.wallet_address) { failure = forbidden('Assinatura de outra carteira.'); return null; }
    const now = ctx.cfg.now();
    try {
      await q.query(`INSERT INTO signatures (kind, document_version_id, user_id, wallet_address, terms_hash, message, signature, created_at) VALUES ('DOCUMENT',$1,$2,$3,$4,$5,$6,$7)`,
        [r.id, userId, ch.wallet_address, r.sha256, ch.message, input.signature, now.toISOString()]);
    } catch (e) {
      if (/signatures_one_doc_accept/.test((e as Error).message)) { failure = conflict('ALREADY_ACCEPTED', 'Documento já aceito.'); return null; }
      throw e;
    }
    await audit(q, { at: now, userId, action: 'DOCUMENT_ACCEPTED', entity: 'document_version', entityId: r.id, dealId, wallet: ch.wallet_address, newValue: { sha256: r.sha256 } });
    return { ok: true };
  });
  if (failure) throw failure;
  return out!;
}

// ================================================================= compliance (somente status informativos)
export async function complianceView(ctx: Ctx, userId: string | null, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealMember(q, dealId, userId);
    const v = await currentVersion(q, dealId);
    const { rows } = await q.query<any>(
      `SELECT pp.id, pp.role_key, pp.seq, pp.wallet_id, u.full_name,
              (SELECT COUNT(*) FROM document_versions dv JOIN documents d ON d.id = dv.document_id
                WHERE d.deal_id = $2 AND dv.requires_acceptance
                  AND dv.version_no = (SELECT MAX(version_no) FROM document_versions x WHERE x.document_id = d.id))::int AS docs_required,
              (SELECT COUNT(*) FROM signatures s JOIN document_versions dv ON dv.id = s.document_version_id JOIN documents d ON d.id = dv.document_id
                WHERE d.deal_id = $2 AND s.user_id = pp.user_id AND s.kind = 'DOCUMENT'
                  AND dv.version_no = (SELECT MAX(version_no) FROM document_versions x WHERE x.document_id = d.id))::int AS docs_accepted
         FROM partnership_participants pp LEFT JOIN users u ON u.id = pp.user_id WHERE pp.version_id = $1 ORDER BY pp.role_key, pp.seq`, [v.id, dealId]);
    return {
      notice: 'Status apenas informativos. A Verum NCNDA não emite aprovação regulatória nem garante legalidade de operações.',
      items: rows.map((r) => {
        const statuses: string[] = [];
        statuses.push(r.wallet_id ? 'Carteira apresentada' : 'Informação pendente');
        if (r.docs_required > 0) statuses.push(r.docs_accepted >= r.docs_required ? 'Documento recebido' : 'Revisão necessária');
        return { participantId: r.id, role: roleLabel(r.role_key, r.seq), name: r.full_name ?? null, statuses };
      }),
    };
  });
}

// ================================================================= perfil e LGPD
export async function profile(ctx: Ctx, userId: string) {
  const { rows: [u] } = await ctx.db.query<any>(
    `SELECT u.id, u.full_name, u.email, u.phone, u.country, u.is_demo, u.deletion_requested_at, w.address
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id AND w.network = $2 WHERE u.id = $1`, [userId, ctx.sig.network]);
  if (!u) throw notFound('Usuário não encontrado.');
  return { id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, country: u.country, isDemo: u.is_demo, wallet: u.address, deletionRequestedAt: u.deletion_requested_at };
}

export async function requestDeletion(ctx: Ctx, userId: string) {
  return ctx.db.tx(async (q) => {
    const { rows } = await q.query<any>(
      `SELECT d.code FROM partnership_participants pp JOIN partnership_versions pv ON pv.id = pp.version_id
         JOIN partnerships p ON p.id = pv.partnership_id JOIN deals d ON d.id = p.deal_id
        WHERE pp.user_id = $1 AND pv.status IN ('PENDING_SIGNATURES','LOCKED','FUNDED','EXECUTING','SETTLED')`, [userId]);
    const now = ctx.cfg.now();
    await q.query(`UPDATE users SET deletion_requested_at = $2 WHERE id = $1`, [userId, now.toISOString()]);
    await audit(q, { at: now, userId, action: 'DELETION_REQUESTED', entity: 'user', entityId: userId });
    const retained = [...new Set(rows.map((r) => r.code))];
    return {
      requested: true,
      retainedFor: retained,
      explanation: retained.length
        ? 'Pedido registrado. Dados vinculados a operações assinadas, travadas ou auditadas são mantidos enquanto durar a obrigação de registro (exceção prevista na LGPD para cumprimento de obrigação e exercício regular de direitos). Os demais dados serão excluídos.'
        : 'Pedido registrado. Seus dados serão excluídos.',
    };
  });
}
