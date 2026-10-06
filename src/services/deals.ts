import type { Queryable } from '../db.ts';
import { forbidden, notFound } from '../lib/common.ts';
import { abbreviateAddress } from '../lib/crypto.ts';
import { formatBps, formatGrade, formatUnits, validateLines, bpsByRole, type AllocationLine, type ResidualPolicy } from '../lib/bps.ts';
import type { Ctx } from './auth.ts';

export const ROLE_LABEL: Record<string, string> = {
  VENDEDOR: 'Vendedor',
  GRUPO_VENDA: 'Grupo Venda',
  INTERMEDIACAO_VENDA: 'Intermediação Venda',
  PAY_MASTER: 'Pay Master / Ligação',
  INTERMEDIACAO_COMPRA: 'Intermediação Compra',
  GRUPO_COMPRA: 'Grupo Compra',
  COMPRADOR: 'Comprador',
};
export const CHAIN_ORDER = ['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR'];
export const ROLE_KEYS = Object.keys(ROLE_LABEL);
/** Endereço do contrato de escrow da parceria. Nenhum contrato implantado nesta entrega (DEMO). */
export const ESCROW_CONTRACT_ADDRESS: string | null = null;

export function roleLabel(roleKey: string, seq = 1): string {
  const base = ROLE_LABEL[roleKey] ?? roleKey;
  return seq > 1 ? `${base} ${String(seq).padStart(2, '0')}` : base;
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_SIGNATURES: 'Aguardando aceites', LOCKED: 'Parceria travada', FUNDED: 'Escrow financiado (DEMO)',
  EXECUTING: 'Em execução', SETTLED: 'Liquidada', EXPIRED: 'Expirada', CANCELLED: 'Cancelada',
};

export const LEG_LABEL: Record<string, string> = {
  ONCHAIN: 'ON-CHAIN',
  CASH_PHYSICAL: 'FORA DA PLATAFORMA — NÃO GARANTIDO POR CONTRATO',
  FIAT_TRANSFER: 'FORA DA PLATAFORMA — NÃO GARANTIDO POR CONTRATO',
  PHYSICAL_ASSET: 'FORA DA PLATAFORMA — NÃO GARANTIDO POR CONTRATO',
};
export const HONESTY_NOTICE = 'A Verum NCNDA não verifica existência, autenticidade ou procedência de dinheiro em espécie, fiat ou ativo físico. Pernas fora da plataforma não são protegidas por smart contract.';

export async function loadLines(q: Queryable, versionId: string): Promise<AllocationLine[]> {
  const { rows } = await q.query<any>(
    `SELECT line_key, label, role_key, role_seq, bps, kind FROM allocation_lines WHERE version_id = $1 ORDER BY position, line_key`, [versionId]);
  return rows.map((r) => ({ lineKey: r.line_key, label: r.label, roleKey: r.role_key, roleSeq: r.role_seq, bps: r.bps, kind: r.kind }));
}

export async function assertDealAdmin(q: Queryable, dealId: string, userId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(String(dealId))) throw notFound('Operação não encontrada.');
  const { rows } = await q.query<{ admin_user_id: string }>(`SELECT admin_user_id FROM deals WHERE id = $1`, [dealId]);
  if (!rows[0]) throw notFound('Operação não encontrada.');
  if (rows[0].admin_user_id !== userId) throw forbidden('Ação exclusiva do admin da operação.');
}

/** Autorização por operação: admin ou participante com convite concluído. */
export async function assertDealMember(q: Queryable, dealId: string, userId: string): Promise<{ isAdmin: boolean }> {
  if (!/^[0-9a-f-]{36}$/.test(String(dealId))) throw notFound('Operação não encontrada.');
  const { rows } = await q.query<any>(
    `SELECT d.admin_user_id, EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.user_id = $2) AS member
       FROM deals d WHERE d.id = $1`, [dealId, userId]);
  if (!rows[0]) throw notFound('Operação não encontrada.');
  const isAdmin = rows[0].admin_user_id === userId;
  if (!isAdmin && !rows[0].member) throw notFound('Operação não encontrada.');
  return { isAdmin };
}

export async function currentVersion(q: Queryable, dealId: string, lock = false) {
  const { rows } = await q.query<any>(
    `SELECT pv.* FROM partnerships p JOIN partnership_versions pv ON pv.id = p.current_version_id WHERE p.deal_id = $1 ${lock ? 'FOR UPDATE OF pv' : ''}`, [dealId]);
  if (!rows[0]) throw notFound('Parceria não encontrada.');
  return rows[0];
}

function participantSort(a: any, b: any): number {
  const pa = a.role_key === 'PAY_MASTER' ? 0 : 1;
  const pb = b.role_key === 'PAY_MASTER' ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const oa = CHAIN_ORDER.indexOf(a.role_key);
  const ob = CHAIN_ORDER.indexOf(b.role_key);
  return oa !== ob ? oa - ob : a.seq - b.seq;
}

export async function dealView(q: Queryable, ctx: Ctx, dealId: string, viewerId: string) {
  const { isAdmin } = await assertDealMember(q, dealId, viewerId);
  const { rows: [d] } = await q.query<any>(
    `SELECT d.id, d.code, d.is_demo, d.admin_user_id, d.created_at, o.id AS offer_id, o.kind, o.title, o.volume_text, o.reference_amount,
            o.reference_asset_id, o.grade_total_bps, o.grade_payer_bps, o.conditions, o.valid_until, b.name AS business_name, b.tagline, b.id AS business_id
       FROM deals d JOIN offers o ON o.id = d.offer_id LEFT JOIN businesses b ON b.id = o.business_id WHERE d.id = $1`, [dealId]);
  const { rows: legs } = await q.query<any>(`SELECT side, asset_id, leg_type, description FROM offer_legs WHERE offer_id = $1 ORDER BY side`, [d.offer_id]);
  const v = await currentVersion(q, dealId);
  const lines = await loadLines(q, v.id);
  const roleBps = bpsByRole(lines);
  const { rows: people } = await q.query<any>(
    `SELECT pp.id, pp.role_key, pp.seq, pp.user_id, u.full_name, u.email, u.phone, w.address,
            EXISTS (SELECT 1 FROM signatures s WHERE s.participant_id = pp.id AND s.kind = 'AGREEMENT' AND s.invalidated_at IS NULL
                     AND s.terms_hash IS NOT DISTINCT FROM $2) AS signed,
            EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = $3 AND dp.user_id = pp.user_id) AS completed,
            (SELECT i.status FROM invitations i WHERE i.participant_id = pp.id ORDER BY i.created_at DESC LIMIT 1) AS last_invite_status,
            (SELECT i.id FROM invitations i WHERE i.participant_id = pp.id ORDER BY i.created_at DESC LIMIT 1) AS last_invite_id
       FROM partnership_participants pp
       LEFT JOIN users u ON u.id = pp.user_id LEFT JOIN wallets w ON w.id = pp.wallet_id
      WHERE pp.version_id = $1`, [v.id, v.terms_hash, dealId]);
  people.sort(participantSort);
  const pmCount = people.filter((p) => p.role_key === 'PAY_MASTER').length;
  const adminIsMember = people.some((p) => p.user_id === d.admin_user_id);
  const signedCount = people.filter((p) => p.signed && v.terms_hash).length;
  const refAsset = d.reference_asset_id ? ctx.assets.byId(d.reference_asset_id) : null;
  const legViews = legs.map((l) => {
    const a = ctx.assets.byId(l.asset_id);
    return { side: l.side, assetId: l.asset_id, symbol: a?.symbol ?? l.asset_id, name: a?.name ?? l.asset_id, description: l.description,
      legType: l.leg_type, onchain: l.leg_type === 'ONCHAIN', chip: LEG_LABEL[l.leg_type] };
  });
  const deliver = legViews.find((l) => l.side === 'ENTREGA');
  const receive = legViews.find((l) => l.side === 'RECEBIMENTO');
  const offPlatform = legViews.some((l) => !l.onchain);
  const now = ctx.cfg.now();
  const me = people.find((p) => p.user_id === viewerId);
  const { rows: [st] } = await q.query<any>(`SELECT * FROM settlements WHERE version_id = $1`, [v.id]);
  const { rows: [vc] } = await q.query<any>(`SELECT COUNT(*)::int AS n FROM partnership_versions WHERE partnership_id = $1`, [v.partnership_id]);
  // Só existe escrow quando houver contrato real implantado e a versão estiver FUNDED/EXECUTING.
  const escrowActive = ['FUNDED', 'EXECUTING'].includes(v.status) && ESCROW_CONTRACT_ADDRESS !== null;
  return {
    id: d.id, code: d.code, isDemo: d.is_demo, isAdmin, createdAt: d.created_at,
    offer: {
      id: d.offer_id, kind: d.kind, kindLabel: d.kind === 'UNICA' ? 'OFERTA ÚNICA' : 'PARCERIA PERMANENTE',
      title: d.title, businessId: d.business_id, businessName: d.business_name, tagline: d.tagline, volume: d.volume_text,
      reference: d.reference_amount && refAsset ? {
        amount: String(d.reference_amount), assetId: refAsset.id, symbol: refAsset.symbol, decimals: refAsset.decimals,
        label: `${formatUnits(BigInt(d.reference_amount), refAsset.decimals, { trim: true })} ${refAsset.symbol}`,
      } : null,
      grade: { totalBps: d.grade_total_bps, payerBps: d.grade_payer_bps, label: formatGrade(d.grade_total_bps, d.grade_payer_bps), discountLabel: formatBps(d.grade_total_bps) },
      conditions: d.conditions as string[],
      validUntil: d.valid_until, expired: d.valid_until ? new Date(d.valid_until) <= now : false,
    },
    legs: legViews,
    direction: `${deliver?.symbol ?? '?'} → ${receive?.symbol ?? '?'}`,
    hasOffPlatformLeg: offPlatform,
    honestyNotice: offPlatform ? HONESTY_NOTICE : null,
    version: {
      id: v.id, no: v.version_no, status: v.status, statusLabel: STATUS_LABEL[v.status], residualPolicy: v.residual_policy as ResidualPolicy,
      termsHash: v.terms_hash, lockedAt: v.locked_at, versionsCount: vc.n, editable: v.status === 'DRAFT', gradeTotalBps: v.grade_total_bps,
    },
    lines: lines.map((l) => ({ ...l, bpsLabel: formatBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })),
    linesValidation: validateLines(lines, v.grade_total_bps),
    participants: people.map((p) => {
      const pmIndex = p.role_key === 'PAY_MASTER' ? p.seq : null;
      const bps = roleBps.get(`${p.role_key}#${p.seq}`) ?? 0;
      const visible = !!p.user_id && p.completed;
      return {
        id: p.id, roleKey: p.role_key, seq: p.seq, role: roleLabel(p.role_key, p.seq),
        isPayMaster: p.role_key === 'PAY_MASTER',
        payMasterBadge: p.role_key === 'PAY_MASTER' ? (pmCount > 1 ? `PAY MASTER ${String(pmIndex).padStart(2, '0')}` : 'PAY MASTER') : null,
        filled: !!p.user_id, isMe: p.user_id === viewerId,
        name: p.full_name ?? null,
        email: visible ? p.email : null, phone: visible ? p.phone : null, contactVisible: visible,
        wallet: p.address ?? null, walletShort: abbreviateAddress(p.address),
        bps, bpsLabel: formatBps(bps), signed: !!(p.signed && v.terms_hash),
        invite: isAdmin && p.last_invite_id ? { id: p.last_invite_id, status: p.last_invite_status } : null,
      };
    }),
    signatures: { k: signedCount, n: people.length, label: `${signedCount}/${people.length} CONFIRMADOS` },
    me: me ? { participantId: me.id, signed: !!(me.signed && v.terms_hash), role: roleLabel(me.role_key, me.seq) } : null,
    adminIsMember,
    settlement: st ? settlementView(ctx, st) : null,
    payment: escrowActive
      ? { mode: 'ESCROW', label: 'PAGAMENTO VIA ESCROW DA PARCERIA' }
      : { mode: 'DIRECT', label: 'PAGAMENTO DIRETO À CARTEIRA DO PARCEIRO — fora do escrow' },
    settlementAdapter: { id: ctx.settlement.id, demo: ctx.settlement.demo, protectedByContract: ctx.settlement.protectedByContract },
  };
}

export function settlementView(ctx: Ctx, st: any) {
  const a = ctx.assets.byId(st.asset_id)!;
  const fmt = (x: string | bigint) => formatUnits(BigInt(x), a.decimals);
  return {
    id: st.id, status: st.status, adapter: st.adapter, assetId: st.asset_id, symbol: a.symbol, decimals: a.decimals,
    referenceAmount: String(st.reference_amount), referenceLabel: `${fmt(st.reference_amount)} ${a.symbol}`,
    poolAmount: String(st.pool_amount), poolLabel: `${fmt(st.pool_amount)} ${a.symbol}`,
    residualUnits: String(st.residual_units), residualLabel: `${fmt(st.residual_units)} ${a.symbol}`,
    truncatedNumerator: st.truncated_numerator,
    truncatedLabel: st.truncated_numerator > 0 ? `${st.truncated_numerator}/10000 da unidade mínima (abaixo da menor unidade do ativo — não distribuível)` : null,
    lines: (st.lines as any[]).map((l) => ({ ...l, amountLabel: `${fmt(l.amount)} ${a.symbol}`, bpsLabel: formatBps(l.bps), role: l.roleKey ? roleLabel(l.roleKey, l.roleSeq) : null })),
    createdAt: st.created_at, settledAt: st.settled_at,
  };
}

/** Banners da Home: uma entrada por operação em que o usuário participa. */
export async function listDeals(q: Queryable, ctx: Ctx, userId: string) {
  const { rows } = await q.query<any>(
    `SELECT d.id FROM deals d WHERE d.admin_user_id = $1
       OR EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.user_id = $1)
     ORDER BY d.created_at ASC`, [userId]);
  const out = [];
  for (const r of rows) {
    const v = await dealView(q, ctx, r.id, userId);
    out.push({
      id: v.id, code: v.code, isDemo: v.isDemo, isAdmin: v.isAdmin, offer: v.offer, legs: v.legs, direction: v.direction,
      hasOffPlatformLeg: v.hasOffPlatformLeg, honestyNotice: v.honestyNotice, version: v.version, lines: v.lines, linesValidation: v.linesValidation,
      signatures: v.signatures, settlementStatus: v.settlement?.status ?? null,
    });
  }
  return out;
}

export async function dashboard(q: Queryable, ctx: Ctx, userId: string) {
  const deals = await listDeals(q, ctx, userId);
  const active = deals.filter((d) => ['LOCKED', 'FUNDED', 'EXECUTING'].includes(d.version.status));
  const awaiting = deals.filter((d) => ['DRAFT', 'PENDING_SIGNATURES'].includes(d.version.status));
  const done = deals.filter((d) => d.version.status === 'SETTLED');
  const permanent = deals.filter((d) => d.offer.kind === 'PERMANENTE');
  const { rows: activity } = await q.query<any>(
    `SELECT a.id, a.at, a.action, a.entity, d.code FROM audit_logs a JOIN deals d ON d.id = a.deal_id
      WHERE d.admin_user_id = $1 OR EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.user_id = $1)
      ORDER BY a.id DESC LIMIT 12`, [userId]);
  return {
    counters: { active: active.length, awaiting: awaiting.length, partnerships: permanent.length, settled: done.length },
    deals,
    activity: activity.map((a) => ({ id: String(a.id), at: a.at, action: a.action, entity: a.entity, dealCode: a.code })),
  };
}

export async function dealHistory(q: Queryable, dealId: string, userId: string) {
  await assertDealMember(q, dealId, userId);
  const { rows } = await q.query<any>(
    `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.old_value, a.new_value, a.wallet, a.user_id, u.full_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE a.deal_id = $1 ORDER BY a.id ASC`, [dealId]);
  return rows.map((r) => ({
    id: String(r.id), at: r.at, action: r.action, entity: r.entity, entityId: r.entity_id, oldValue: r.old_value, newValue: r.new_value,
    walletShort: r.wallet ? abbreviateAddress(r.wallet) : null, actor: r.full_name ?? (r.user_id ? 'Participante' : 'Sistema'),
  }));
}
