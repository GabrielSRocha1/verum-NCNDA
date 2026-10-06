import { randomBytes } from 'node:crypto';
import type { Queryable } from '../db.ts';
import { openDeadline } from '../config.ts';
import { newToken, newInviteCode, normalizeInviteCode, sha256Hex, hmacHex, safeEqualHex, signValue, unsignValue, abbreviateAddress } from '../lib/crypto.ts';
import { HttpError, invalidInvite, forbidden, conflict, badRequest, audit, maskEmail, maskPhone } from '../lib/common.ts';
import { formatBps, bpsByRole } from '../lib/bps.ts';
import { issueChallenge, consumeChallenge, type Ctx } from './auth.ts';
import { loadLines, assertDealAdmin, roleLabel } from './deals.ts';

export const INVITE_COOKIE = 'votc_inv';
export const STATUS_LABEL: Record<string, string> = {
  ATIVO: 'ATIVO', ABERTO: 'ABERTO', CONCLUIDO: 'CONCLUÍDO', EXPIRADO: 'EXPIRADO', REVOGADO: 'REVOGADO', BLOQUEADO: 'BLOQUEADO',
};

const codeHash = (ctx: Ctx, code: string) => hmacHex(ctx.cfg.invitePepper, code);

function inviteMessage(ctx: Ctx, p: { dealCode: string; role: string; link: string; code: string }): string {
  const lines = [
    'VERUM NCNDA — Convite privado',
    `Operação: ${p.dealCode} · Função: ${p.role}`,
    `Link (uso único): ${p.link}`,
    `Código: ${p.code}`,
    'Para entrar você precisa da Verum Wallet (carteira de autocustódia, as chaves ficam só com você).' +
      (ctx.cfg.verumWalletDownloadUrl ? ` Se ainda não tem, baixe antes: ${ctx.cfg.verumWalletDownloadUrl}` : ' Se ainda não tem, peça o link de download ao responsável pela mesa.'),
    'Atenção: o convite só pode ser aberto UMA vez. Se abrir sem a carteira instalada, peça um novo link.',
  ];
  return lines.join('\n');
}

// ================================================================= expiração automática
export async function sweepInvitations(q: Queryable, ctx: Ctx): Promise<number> {
  const now = ctx.cfg.now();
  const minutes = Math.max(ctx.cfg.resumeWindowMinutes, ctx.cfg.onboardingTtlMinutes);
  const { rows } = await q.query<{ id: string; deal_id: string; prev: string }>(
    `WITH due AS (
       SELECT id, status AS prev FROM invitations
        WHERE (status = 'ATIVO' AND expires_at <= $1)
           OR (status = 'ABERTO' AND LEAST(opened_at + make_interval(mins => $2), expires_at) <= $1)
        FOR UPDATE)
     UPDATE invitations i SET status = 'EXPIRADO' FROM due WHERE i.id = due.id
     RETURNING i.id, i.deal_id, due.prev`,
    [now.toISOString(), minutes],
  );
  for (const r of rows) {
    await audit(q, { at: now, action: 'INVITE_EXPIRED', entity: 'invitation', entityId: r.id, dealId: r.deal_id, oldValue: { status: r.prev }, newValue: { status: 'EXPIRADO' } });
  }
  return rows.length;
}

// ================================================================= admin: gerar / listar / revogar / regenerar
async function slotForInvite(q: Queryable, dealId: string, roleKey: string, roleSeq: number) {
  const { rows } = await q.query<any>(
    `SELECT pp.id, pp.wallet_id, pv.id AS version_id, pv.status, d.code AS deal_code
       FROM deals d JOIN partnerships p ON p.deal_id = d.id
       JOIN partnership_versions pv ON pv.id = p.current_version_id
       JOIN partnership_participants pp ON pp.version_id = pv.id
      WHERE d.id = $1 AND pp.role_key = $2 AND pp.seq = $3`, [dealId, roleKey, roleSeq]);
  return rows[0] ?? null;
}

async function insertInvitation(q: Queryable, ctx: Ctx, adminId: string, dealId: string, roleKey: string, roleSeq: number, ttlHours: number) {
  const slot = await slotForInvite(q, dealId, roleKey, roleSeq);
  if (!slot) throw badRequest('SLOT_NOT_FOUND', 'Essa função não existe na versão atual da parceria.');
  if (slot.status !== 'DRAFT') throw conflict('VERSION_LOCKED', 'Parceria fora de DRAFT: convites só podem ser gerados dentro de uma nova versão.');
  if (slot.wallet_id) throw conflict('SLOT_FILLED', 'Essa função já está ocupada por um parceiro cadastrado.');
  const lines = await loadLines(q, slot.version_id);
  const bps = bpsByRole(lines).get(`${roleKey}#${roleSeq}`) ?? 0;
  const token = newToken();
  const code = newInviteCode();
  const now = ctx.cfg.now();
  const expires = new Date(now.getTime() + ttlHours * 3600_000);
  let row: any;
  try {
    ({ rows: [row] } = await q.query<any>(
      `INSERT INTO invitations (deal_id, partnership_version_id, participant_id, role_id, role_seq, bps, token_hash, code_hash, expires_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, status, created_at, expires_at`,
      [dealId, slot.version_id, slot.id, roleKey, roleSeq, bps, sha256Hex(token), codeHash(ctx, code), expires.toISOString(), adminId, now.toISOString()]));
  } catch (e) {
    if (/invitations_one_live_per_slot/.test((e as Error).message)) throw conflict('LIVE_INVITE_EXISTS', 'Já existe um convite ativo para essa função. Revogue ou gere novo link.');
    throw e;
  }
  const link = `${ctx.cfg.publicOrigin}/i/${token}`;
  const role = roleLabel(roleKey, roleSeq);
  await audit(q, { at: now, userId: adminId, action: 'INVITE_CREATED', entity: 'invitation', entityId: row.id, dealId, newValue: { role_key: roleKey, role_seq: roleSeq, bps, expires_at: expires.toISOString() } });
  await audit(q, { at: now, userId: adminId, action: 'PARTICIPANT_INVITED', entity: 'partnership_participant', entityId: slot.id, dealId, newValue: { role_key: roleKey, role_seq: roleSeq } });
  return {
    invitation: { id: row.id, status: row.status, roleKey, roleSeq, role, bps, bpsLabel: formatBps(bps), createdAt: row.created_at, expiresAt: row.expires_at },
    link, code,
    message: inviteMessage(ctx, { dealCode: slot.deal_code, role, link, code }),
  };
}

export async function createInvitation(ctx: Ctx, adminId: string, input: { dealId: string; roleKey: string; roleSeq?: number; ttlHours?: number }) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, input.dealId, adminId);
    await sweepInvitations(q, ctx);
    return insertInvitation(q, ctx, adminId, input.dealId, input.roleKey, input.roleSeq ?? 1, input.ttlHours ?? ctx.cfg.inviteTtlHours);
  });
}

export async function listInvitations(ctx: Ctx, adminId: string, dealId?: string) {
  return ctx.db.tx(async (q) => {
    await sweepInvitations(q, ctx);
    const params: unknown[] = [adminId];
    let where = 'd.admin_user_id = $1';
    if (dealId) { params.push(dealId); where += ' AND d.id = $2'; }
    const { rows } = await q.query<any>(
      `SELECT i.id, i.status, i.role_id, i.role_seq, i.bps, i.created_at, i.opened_at, i.completed_at, i.expires_at, i.revoked_at,
              i.replaced_by_id, d.id AS deal_id, d.code AS deal_code, o.title, pv.version_no
         FROM invitations i JOIN deals d ON d.id = i.deal_id JOIN offers o ON o.id = d.offer_id
         JOIN partnership_versions pv ON pv.id = i.partnership_version_id
        WHERE ${where} ORDER BY i.created_at DESC LIMIT 200`, params);
    return rows.map((r) => ({
      id: r.id, status: r.status, statusLabel: STATUS_LABEL[r.status], role: roleLabel(r.role_id, r.role_seq), roleKey: r.role_id, roleSeq: r.role_seq,
      bps: r.bps, bpsLabel: formatBps(r.bps), createdAt: r.created_at, openedAt: r.opened_at, completedAt: r.completed_at,
      expiresAt: r.expires_at, revokedAt: r.revoked_at, replacedById: r.replaced_by_id, dealId: r.deal_id, dealCode: r.deal_code,
      title: r.title, versionNo: r.version_no,
      canRevoke: r.status === 'ATIVO' || r.status === 'ABERTO',
      canRegenerate: r.status !== 'CONCLUIDO' && !r.replaced_by_id,
    }));
  });
}

async function loadInviteForAdmin(q: Queryable, id: string, adminId: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Convite não encontrado.');
  const { rows } = await q.query<any>(`SELECT i.*, d.admin_user_id FROM invitations i JOIN deals d ON d.id = i.deal_id WHERE i.id = $1 FOR UPDATE`, [id]);
  const inv = rows[0];
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Convite não encontrado.');
  if (inv.admin_user_id !== adminId) throw forbidden('Só o admin da operação gerencia convites.');
  return inv;
}

export async function revokeInvitation(ctx: Ctx, adminId: string, id: string) {
  return ctx.db.tx(async (q) => {
    await sweepInvitations(q, ctx);
    const inv = await loadInviteForAdmin(q, id, adminId);
    if (inv.status !== 'ATIVO' && inv.status !== 'ABERTO') throw conflict('INVITE_NOT_REVOCABLE', `Convite ${STATUS_LABEL[inv.status]} não pode ser revogado.`);
    const now = ctx.cfg.now();
    await q.query(`UPDATE invitations SET status = 'REVOGADO', revoked_at = $2 WHERE id = $1`, [id, now.toISOString()]);
    await audit(q, { at: now, userId: adminId, action: 'INVITE_REVOKED', entity: 'invitation', entityId: id, dealId: inv.deal_id, oldValue: { status: inv.status }, newValue: { status: 'REVOGADO' } });
    return { id, status: 'REVOGADO' };
  });
}

/** Revoga o anterior (se ainda vivo) e cria outro para a mesma função/percentual. */
export async function regenerateInvitation(ctx: Ctx, adminId: string, id: string, ttlHours?: number) {
  return ctx.db.tx(async (q) => {
    await sweepInvitations(q, ctx);
    const inv = await loadInviteForAdmin(q, id, adminId);
    if (inv.status === 'CONCLUIDO') throw conflict('INVITE_COMPLETED', 'Convite já concluído: o parceiro entra pela Verum Wallet.');
    if (inv.replaced_by_id) throw conflict('INVITE_ALREADY_REPLACED', 'Esse convite já foi substituído.');
    const now = ctx.cfg.now();
    if (inv.status === 'ATIVO' || inv.status === 'ABERTO') {
      await q.query(`UPDATE invitations SET status = 'REVOGADO', revoked_at = $2 WHERE id = $1`, [id, now.toISOString()]);
      await audit(q, { at: now, userId: adminId, action: 'INVITE_REVOKED', entity: 'invitation', entityId: id, dealId: inv.deal_id, oldValue: { status: inv.status }, newValue: { status: 'REVOGADO' } });
    }
    const created = await insertInvitation(q, ctx, adminId, inv.deal_id, inv.role_id, inv.role_seq, ttlHours ?? ctx.cfg.inviteTtlHours);
    await q.query(`UPDATE invitations SET replaced_by_id = $2 WHERE id = $1`, [id, created.invitation.id]);
    await audit(q, { at: now, userId: adminId, action: 'INVITE_REGENERATED', entity: 'invitation', entityId: id, dealId: inv.deal_id, newValue: { replaced_by_id: created.invitation.id } });
    return created;
  });
}

// ================================================================= parceiro: abrir / retomar / etapas
export interface InviteCookie { value: string; maxAgeSec: number }

async function findByToken(q: Queryable, token: string, lock = true) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await q.query<any>(`SELECT * FROM invitations WHERE token_hash = $1 ${lock ? 'FOR UPDATE' : ''}`, [sha256Hex(token)]);
  return rows[0] ?? null;
}

function parseInviteCookie(ctx: Ctx, raw: string | undefined): { inviteId: string; sess: string } | null {
  const payload = unsignValue(ctx.cfg.sessionSecret, raw);
  if (!payload) return null;
  const [inviteId, sess] = payload.split(':');
  if (!inviteId || !sess) return null;
  return { inviteId, sess };
}

/** POST /invite/open — consome o convite (ATIVO → ABERTO) e vincula a este navegador. */
export async function openInvitation(ctx: Ctx, token: string): Promise<{ cookie: InviteCookie; walletDownloadUrl: string | null }> {
  return ctx.db.tx(async (q) => {
    await sweepInvitations(q, ctx);
    const inv = await findByToken(q, token);
    const now = ctx.cfg.now();
    if (!inv || inv.status !== 'ATIVO' || new Date(inv.expires_at) <= now) throw invalidInvite();
    const sess = randomBytes(24).toString('base64url');
    await q.query(`UPDATE invitations SET status = 'ABERTO', opened_at = $2, opened_session_hash = $3 WHERE id = $1`, [inv.id, now.toISOString(), sha256Hex(sess)]);
    await audit(q, { at: now, action: 'INVITE_OPENED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, oldValue: { status: 'ATIVO' }, newValue: { status: 'ABERTO' } });
    const deadline = openDeadline(ctx.cfg, now, new Date(inv.expires_at));
    return {
      cookie: { value: signValue(ctx.cfg.sessionSecret, `${inv.id}:${sess}`), maxAgeSec: Math.max(1, Math.ceil((deadline.getTime() - now.getTime()) / 1000)) },
      walletDownloadUrl: ctx.cfg.verumWalletDownloadUrl || null,
    };
  });
}

/** Carrega o convite ABERTO deste navegador; expira se o prazo passou. Qualquer falha → mensagem genérica. */
async function requireOpen(q: Queryable, ctx: Ctx, token: string, rawCookie: string | undefined, mode: 'step' | 'resume') {
  const inv = await findByToken(q, token);
  const ck = parseInviteCookie(ctx, rawCookie);
  if (!inv || !ck || ck.inviteId !== inv.id || inv.status !== 'ABERTO' || !inv.opened_session_hash
      || !safeEqualHex(sha256Hex(ck.sess), inv.opened_session_hash)) throw invalidInvite();
  const now = ctx.cfg.now();
  const openedAt = new Date(inv.opened_at);
  const deadline = openDeadline(ctx.cfg, openedAt, new Date(inv.expires_at));
  if (now >= deadline) {
    await q.query(`UPDATE invitations SET status = 'EXPIRADO' WHERE id = $1 AND status = 'ABERTO'`, [inv.id]);
    await audit(q, { at: now, action: 'INVITE_EXPIRED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, oldValue: { status: 'ABERTO' }, newValue: { status: 'EXPIRADO' } });
    return { expired: true as const, inv };
  }
  if (mode === 'resume') {
    const windowMs = ctx.cfg.resumeWindowMinutes * 60_000;
    if (windowMs === 0 || now.getTime() - openedAt.getTime() > windowMs) return { expired: true as const, inv, noResume: true };
  }
  return { expired: false as const, inv };
}

/** Executa uma etapa dentro de transação; expiração é persistida antes de responder com a mensagem genérica. */
async function step<T>(ctx: Ctx, token: string, cookie: string | undefined, mode: 'step' | 'resume', fn: (q: Queryable, inv: any) => Promise<T>): Promise<T> {
  let expired = false;
  const out = await ctx.db.tx(async (q) => {
    const r = await requireOpen(q, ctx, token, cookie, mode);
    if (r.expired) { expired = true; return null as T; }
    return fn(q, r.inv);
  });
  if (expired) throw invalidInvite();
  return out;
}

/** Resumo exibido só depois do código correto. Contatos dos demais ficam ocultos (visitante vê nome e função). */
async function inviteSummary(q: Queryable, inv: any) {
  const { rows: [d] } = await q.query<any>(
    `SELECT d.code, o.title, o.kind, o.volume_text, o.grade_total_bps, o.grade_payer_bps,
            (SELECT asset_id FROM offer_legs WHERE offer_id = o.id AND side = 'ENTREGA') AS deliver,
            (SELECT asset_id FROM offer_legs WHERE offer_id = o.id AND side = 'RECEBIMENTO') AS receive
       FROM deals d JOIN offers o ON o.id = d.offer_id WHERE d.id = $1`, [inv.deal_id]);
  const { rows: people } = await q.query<any>(
    `SELECT pp.role_key, pp.seq, u.full_name, u.email, u.phone FROM partnership_participants pp
       LEFT JOIN users u ON u.id = pp.user_id
      WHERE pp.version_id = $1 ORDER BY pp.role_key, pp.seq`, [inv.partnership_version_id]);
  return {
    dealCode: d.code, title: d.title, kind: d.kind, volume: d.volume_text,
    direction: { deliver: d.deliver, receive: d.receive },
    grade: { totalBps: d.grade_total_bps, payerBps: d.grade_payer_bps },
    role: roleLabel(inv.role_id, inv.role_seq), roleKey: inv.role_id, bps: inv.bps, bpsLabel: formatBps(inv.bps),
    participants: people.map((p) => ({
      role: roleLabel(p.role_key, p.seq), name: p.full_name ?? null,
      email: p.email ? maskEmail(p.email) : null, phone: p.phone ? maskPhone(p.phone) : null,
    })),
  };
}

function stepOf(inv: any): 'CHOICE' | 'WALLET' | 'SIGNUP' | 'TERMS' {
  if (!inv.code_verified_at) return 'CHOICE';
  if (!inv.wallet_verified_at) return 'WALLET';
  if (!inv.user_id) return 'SIGNUP';
  return 'TERMS';
}

export async function resumeInvitation(ctx: Ctx, token: string, cookie: string | undefined) {
  return step(ctx, token, cookie, 'resume', async (q, inv) => ({
    step: stepOf(inv),
    walletDownloadUrl: ctx.cfg.verumWalletDownloadUrl || null,
    summary: inv.code_verified_at ? await inviteSummary(q, inv) : null,
    walletAddress: inv.pending_wallet_address ?? null,
  }));
}

export async function verifyInviteCode(ctx: Ctx, token: string, cookie: string | undefined, rawCode: string) {
  let failure: HttpError | null = null;
  const out = await step(ctx, token, cookie, 'step', async (q, inv) => {
    const now = ctx.cfg.now();
    const code = normalizeInviteCode(rawCode);
    const ok = safeEqualHex(codeHash(ctx, code ?? 'VOTC-INVALID'), inv.code_hash) && code !== null;
    if (!ok) {
      const attempts = inv.failed_attempts + 1;
      const blocked = attempts >= 5;
      await q.query(`UPDATE invitations SET failed_attempts = $2, status = $3 WHERE id = $1`, [inv.id, attempts, blocked ? 'BLOQUEADO' : 'ABERTO']);
      await audit(q, { at: now, action: 'INVITE_CODE_FAILED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, newValue: { failed_attempts: attempts } });
      if (blocked) {
        await audit(q, { at: now, action: 'INVITE_BLOCKED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, oldValue: { status: 'ABERTO' }, newValue: { status: 'BLOQUEADO' } });
        failure = invalidInvite();
      } else {
        failure = new HttpError(400, 'CODE_INVALID', `Código inválido. Tentativas restantes: ${5 - attempts}.`);
        (failure as any).remaining = 5 - attempts;
      }
      return null;
    }
    if (!inv.code_verified_at) {
      await q.query(`UPDATE invitations SET code_verified_at = $2 WHERE id = $1`, [inv.id, now.toISOString()]);
      await audit(q, { at: now, action: 'INVITE_CODE_VERIFIED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id });
    }
    return { step: 'WALLET' as const, summary: await inviteSummary(q, inv) };
  });
  if (failure) throw failure;
  return out!;
}

export async function inviteWalletChallenge(ctx: Ctx, token: string, cookie: string | undefined, address: string) {
  return step(ctx, token, cookie, 'step', async (q, inv) => {
    if (!inv.code_verified_at) throw badRequest('CODE_REQUIRED', 'Informe o código do convite primeiro.');
    const { rows: [d] } = await q.query<any>(`SELECT code FROM deals WHERE id = $1`, [inv.deal_id]);
    return issueChallenge(q, ctx, {
      purpose: 'INVITE', address, invitationId: inv.id,
      context: { Convite: inv.id, 'Operação': d.code, Data: ctx.cfg.now().toISOString().slice(0, 10) },
    });
  });
}

export async function inviteWalletVerify(ctx: Ctx, token: string, cookie: string | undefined, input: { challengeId: string; nonce: string; signature: string }) {
  let failure: HttpError | null = null;
  const out = await step(ctx, token, cookie, 'step', async (q, inv) => {
    if (!inv.code_verified_at) throw badRequest('CODE_REQUIRED', 'Informe o código do convite primeiro.');
    let ch;
    try {
      ch = await consumeChallenge(q, ctx, { ...input, purpose: 'INVITE', invitationId: inv.id });
    } catch (e) { failure = e as HttpError; return null; }   // mantém o consumo do challenge (commit)
    const now = ctx.cfg.now();
    const { rows: [w] } = await q.query<any>(`SELECT id, user_id FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, ch.wallet_address]);
    if (w) {
      const { rows: clash } = await q.query<any>(
        `SELECT 1 FROM partnership_participants WHERE version_id = $1 AND (wallet_id = $2 OR user_id = $3)`, [inv.partnership_version_id, w.id, w.user_id]);
      if (clash.length) { failure = conflict('WALLET_ALREADY_IN_VERSION', 'Esta carteira já ocupa outra função nesta versão da parceria.'); return null; }
    }
    await q.query(
      `UPDATE invitations SET pending_wallet_address = $2, wallet_verified_at = $3, user_id = $4, wallet_id = $5 WHERE id = $1`,
      [inv.id, ch.wallet_address, now.toISOString(), w?.user_id ?? null, w?.id ?? null]);
    await audit(q, { at: now, userId: w?.user_id ?? null, action: 'WALLET_CHALLENGE_SIGNED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, wallet: ch.wallet_address });
    await audit(q, { at: now, userId: w?.user_id ?? null, action: 'WALLET_CONNECTED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, wallet: ch.wallet_address });
    return { existingUser: !!w, step: w ? 'TERMS' as const : 'SIGNUP' as const, walletAddress: ch.wallet_address, walletShort: abbreviateAddress(ch.wallet_address) };
  });
  if (failure) throw failure;
  return out!;
}

export interface SignupInput { fullName: string; email: string; phone: string; country: string }
export function validateSignup(i: SignupInput): string[] {
  const errs: string[] = [];
  const name = String(i.fullName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 5 || name.length > 120 || !/^[\p{L}][\p{L}' .-]+$/u.test(name) || name.split(' ').length < 2) errs.push('Nome completo inválido (nome e sobrenome).');
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(String(i.email ?? '')) || String(i.email).length > 254) errs.push('E-mail inválido.');
  if (!/^\+?[0-9 ()-]{8,24}$/.test(String(i.phone ?? '')) || String(i.phone).replace(/\D/g, '').length < 8) errs.push('Telefone inválido (use DDI, ex.: +55 11 91234-5678).');
  if (!/^[A-Z]{2}$/.test(String(i.country ?? ''))) errs.push('País inválido (código de 2 letras).');
  return errs;
}

export async function inviteSignup(ctx: Ctx, token: string, cookie: string | undefined, input: SignupInput) {
  const errs = validateSignup(input);
  if (errs.length) throw new HttpError(400, 'VALIDATION', errs.join(' '));
  return step(ctx, token, cookie, 'step', async (q, inv) => {
    if (!inv.wallet_verified_at || !inv.pending_wallet_address) throw badRequest('WALLET_REQUIRED', 'Conecte a Verum Wallet primeiro.');
    if (inv.user_id) throw conflict('ALREADY_REGISTERED', 'Carteira já cadastrada: siga para o aceite dos termos.');
    const email = input.email.trim().toLowerCase();
    const { rows: dup } = await q.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
    if (dup.length) throw conflict('EMAIL_IN_USE', 'Este e-mail já está vinculado a outra carteira.');
    const { rows: wdup } = await q.query(`SELECT 1 FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, inv.pending_wallet_address]);
    if (wdup.length) throw conflict('WALLET_IN_USE', 'Carteira já cadastrada.');
    const now = ctx.cfg.now();
    const { rows: [u] } = await q.query<any>(
      `INSERT INTO users (full_name, email, phone, country, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.fullName.trim().replace(/\s+/g, ' '), email, input.phone.trim(), input.country, now.toISOString()]);
    const { rows: [w] } = await q.query<any>(
      `INSERT INTO wallets (user_id, network, address, provider, created_at) VALUES ($1,$2,$3,'verum-wallet',$4) RETURNING id`,
      [u.id, ctx.sig.network, inv.pending_wallet_address, now.toISOString()]);
    await q.query(`UPDATE invitations SET user_id = $2, wallet_id = $3 WHERE id = $1`, [inv.id, u.id, w.id]);
    await audit(q, { at: now, userId: u.id, action: 'SIGNUP_COMPLETED', entity: 'user', entityId: u.id, dealId: inv.deal_id, wallet: inv.pending_wallet_address });
    return { step: 'TERMS' as const };
  });
}

export async function inviteComplete(ctx: Ctx, token: string, cookie: string | undefined) {
  return step(ctx, token, cookie, 'step', async (q, inv) => {
    if (!inv.user_id || !inv.wallet_id) throw badRequest('SIGNUP_REQUIRED', 'Conclua o cadastro primeiro.');
    const now = ctx.cfg.now();
    try {
      await q.query(`UPDATE partnership_participants SET user_id = $2, wallet_id = $3 WHERE id = $1 AND wallet_id IS NULL`, [inv.participant_id, inv.user_id, inv.wallet_id]);
    } catch (e) {
      if (/unique|duplicate/i.test((e as Error).message)) throw conflict('WALLET_ALREADY_IN_VERSION', 'Esta carteira já ocupa outra função nesta versão da parceria.');
      if (/LOCKED_VERSION/.test((e as Error).message)) throw conflict('VERSION_LOCKED', 'A parceria saiu de DRAFT. Peça um convite na nova versão.');
      throw e;
    }
    const { rows: [slot] } = await q.query<any>(`SELECT user_id FROM partnership_participants WHERE id = $1`, [inv.participant_id]);
    if (slot.user_id !== inv.user_id) throw conflict('SLOT_FILLED', 'Essa função já foi ocupada.');
    await q.query(`INSERT INTO deal_participants (deal_id, user_id, via_invitation, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [inv.deal_id, inv.user_id, inv.id, now.toISOString()]);
    await q.query(`UPDATE users SET terms_accepted_at = COALESCE(terms_accepted_at, $2) WHERE id = $1`, [inv.user_id, now.toISOString()]);
    // Conta que tinha entrado só por link de visualização passa a ser parceiro de verdade: concluiu
    // um convite, ocupa uma cadeira, e deixa de ser leitura apenas.
    await q.query(`UPDATE users SET origin = 'INVITE' WHERE id = $1 AND origin = 'VIEW_LINK'`, [inv.user_id]);
    await q.query(`UPDATE invitations SET status = 'CONCLUIDO', completed_at = $2 WHERE id = $1`, [inv.id, now.toISOString()]);
    await audit(q, { at: now, userId: inv.user_id, action: 'INVITE_COMPLETED', entity: 'invitation', entityId: inv.id, dealId: inv.deal_id, oldValue: { status: 'ABERTO' }, newValue: { status: 'CONCLUIDO' }, wallet: inv.pending_wallet_address });
    return { dealId: inv.deal_id as string, userId: inv.user_id as string, address: inv.pending_wallet_address as string };
  });
}
