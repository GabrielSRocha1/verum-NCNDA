import { randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { sha256Hex, signValue, unsignValue, base58Encode, safeEqualHex } from '../lib/crypto.ts';
import { HttpError, RateLimiter, audit } from '../lib/common.ts';
import { AssetAdapter, type SignatureAdapter, type SettlementAdapter } from '../adapters/index.ts';

export interface Ctx {
  db: Db;
  cfg: AppConfig;
  assets: AssetAdapter;
  sig: SignatureAdapter;
  settlement: SettlementAdapter;
  limiter: RateLimiter;
}

export type ChallengePurpose = 'INVITE' | 'LOGIN' | 'AGREEMENT' | 'DOCUMENT' | 'SETTLEMENT';

const PURPOSE_TEXT: Record<ChallengePurpose, string> = {
  INVITE: 'Prova de posse de carteira (convite)',
  LOGIN: 'Prova de posse de carteira (login)',
  AGREEMENT: 'SIGNATURE OF AGREEMENT — aceite da parceria',
  DOCUMENT: 'Aceite de documento',
  SETTLEMENT: 'AUTORIZAR LIQUIDAÇÃO',
};

/** Mensagem determinística assinada pela carteira. Reconstruída no servidor a partir do registro + nonce. */
export function buildChallengeMessage(domain: string, row: {
  purpose: ChallengePurpose; wallet_address: string; context: Record<string, string>;
  issued_at: Date; expires_at: Date;
}, nonce: string): string {
  const lines = [
    'VERUM NCNDA',
    PURPOSE_TEXT[row.purpose],
    `Domínio: ${domain}`,
    `Carteira: ${row.wallet_address}`,
  ];
  const ctxKeys = Object.keys(row.context).sort();
  for (const k of ctxKeys) lines.push(`${k}: ${row.context[k]}`);
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Emitido em: ${row.issued_at.toISOString()}`);
  lines.push(`Expira em: ${row.expires_at.toISOString()}`);
  if (row.purpose === 'SETTLEMENT') {
    lines.push('Esta assinatura autoriza a liquidação descrita acima.');
  } else {
    lines.push('Esta assinatura NÃO autoriza transação e NÃO movimenta fundos.');
  }
  return lines.join('\n');
}

export async function issueChallenge(q: Queryable, ctx: Ctx, input: {
  purpose: ChallengePurpose; address: string; invitationId?: string | null; context: Record<string, string>;
}): Promise<{ challengeId: string; message: string; nonce: string; expiresAt: string }> {
  if (!ctx.sig.isValidAddress(input.address)) throw new HttpError(400, 'INVALID_ADDRESS', 'Endereço de carteira inválido.');
  const nonce = base58Encode(randomBytes(24));
  const now = ctx.cfg.now();
  const exp = new Date(now.getTime() + ctx.cfg.challengeTtlSeconds * 1000);
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO wallet_challenges (purpose, invitation_id, wallet_address, nonce_hash, context, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.purpose, input.invitationId ?? null, input.address, sha256Hex(nonce), JSON.stringify(input.context), now.toISOString(), exp.toISOString()],
  );
  const message = buildChallengeMessage(ctx.cfg.publicOrigin, {
    purpose: input.purpose, wallet_address: input.address, context: input.context, issued_at: now, expires_at: exp,
  }, nonce);
  return { challengeId: rows[0].id, message, nonce, expiresAt: exp.toISOString() };
}

export interface ConsumedChallenge {
  id: string; purpose: ChallengePurpose; wallet_address: string; invitation_id: string | null;
  context: Record<string, string>; message: string;
}

/**
 * Consome o challenge (uso único, mesmo que a assinatura falhe) e verifica a assinatura.
 * Replay, expiração, chave diferente e finalidade errada são rejeitados com o mesmo erro.
 */
export async function consumeChallenge(q: Queryable, ctx: Ctx, input: {
  challengeId: string; nonce: string; signature: string; purpose: ChallengePurpose; invitationId?: string | null;
}): Promise<ConsumedChallenge> {
  const fail = () => new HttpError(401, 'SIGNATURE_INVALID', 'Assinatura inválida ou expirada. Gere um novo desafio.');
  if (!/^[0-9a-f-]{36}$/.test(input.challengeId)) throw fail();
  const now = ctx.cfg.now();
  const { rows } = await q.query<any>(
    `UPDATE wallet_challenges SET consumed_at = $2
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING id, purpose, wallet_address, invitation_id, nonce_hash, context, issued_at, expires_at`,
    [input.challengeId, now.toISOString()],
  );
  const row = rows[0];
  if (!row) throw fail();
  if (row.purpose !== input.purpose) throw fail();
  if ((input.invitationId ?? null) !== (row.invitation_id ?? null)) throw fail();
  if (!safeEqualHex(sha256Hex(String(input.nonce ?? '')), row.nonce_hash)) throw fail();
  const message = buildChallengeMessage(ctx.cfg.publicOrigin, {
    purpose: row.purpose, wallet_address: row.wallet_address, context: row.context,
    issued_at: new Date(row.issued_at), expires_at: new Date(row.expires_at),
  }, input.nonce);
  if (!ctx.sig.verifyMessage(row.wallet_address, message, String(input.signature ?? ''))) throw fail();
  return { id: row.id, purpose: row.purpose, wallet_address: row.wallet_address, invitation_id: row.invitation_id, context: row.context, message };
}

// ---------------------------------------------------------------- sessão (cookie assinado, curta, renovável)
export const SESSION_COOKIE = 'votc_session';
export interface Session { uid: string; addr: string; iat: number; exp: number; max: number }

export function makeSessionCookie(ctx: Ctx, uid: string, addr: string, startedAt?: number): { value: string; maxAgeSec: number; session: Session } {
  const now = ctx.cfg.now().getTime();
  const iat = startedAt ?? now;
  const max = iat + ctx.cfg.sessionMaxHours * 3600_000;
  const exp = Math.min(now + ctx.cfg.sessionTtlMinutes * 60_000, max);
  const session: Session = { uid, addr, iat, exp, max };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return { value: signValue(ctx.cfg.sessionSecret, payload), maxAgeSec: Math.max(1, Math.floor((exp - now) / 1000)), session };
}

export function readSessionCookie(ctx: Ctx, raw: string | undefined): Session | null {
  const payload = unsignValue(ctx.cfg.sessionSecret, raw);
  if (!payload) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    const now = ctx.cfg.now().getTime();
    if (typeof s.uid !== 'string' || s.exp <= now || s.max <= now) return null;
    return s;
  } catch { return null; }
}

// ---------------------------------------------------------------- login por carteira (sem senha)
export async function loginChallenge(ctx: Ctx, address: string) {
  return issueChallenge(ctx.db, ctx, { purpose: 'LOGIN', address, context: { Finalidade: 'Entrar na mesa privada' } });
}

export async function loginVerify(ctx: Ctx, input: { challengeId: string; nonce: string; signature: string }) {
  return ctx.db.tx(async (q) => {
    const ch = await consumeChallenge(q, ctx, { ...input, purpose: 'LOGIN' });
    const { rows } = await q.query<{ user_id: string }>(
      `SELECT w.user_id FROM wallets w WHERE w.network = $1 AND w.address = $2`, [ctx.sig.network, ch.wallet_address]);
    if (!rows[0]) throw new HttpError(403, 'WALLET_NOT_REGISTERED', 'Carteira sem cadastro. O acesso começa por um convite privado.');
    await audit(q, { at: ctx.cfg.now(), userId: rows[0].user_id, action: 'LOGIN', entity: 'user', entityId: rows[0].user_id, wallet: ch.wallet_address });
    return { userId: rows[0].user_id, address: ch.wallet_address };
  });
}
