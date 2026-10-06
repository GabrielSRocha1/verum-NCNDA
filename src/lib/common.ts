import type { Queryable } from '../db.ts';
import type { RateLimitRule } from '../config.ts';

// ---------------------------------------------------------------- erros HTTP
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
/** Mensagem única para qualquer convite inválido (não revela o motivo). */
export const INVALID_INVITE_MESSAGE = 'Este convite não é mais válido. Peça um novo link.';
export const invalidInvite = () => new HttpError(404, 'INVITE_INVALID', INVALID_INVITE_MESSAGE);
export const forbidden = (msg = 'Acesso negado a esta operação.') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Não encontrado.') => new HttpError(404, 'NOT_FOUND', msg);
export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);

// ---------------------------------------------------------------- privacidade
export function maskEmail(email: string): string {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}
export function maskPhone(phone: string): string {
  const digits = String(phone).replace(/\D/g, '');
  const last = digits.slice(-4);
  const cc = String(phone).trim().startsWith('+') ? `+${digits.slice(0, 2)} ` : '';
  return `${cc}** *****-${last}`;
}

// ---------------------------------------------------------------- auditoria
export type AuditAction =
  | 'DEAL_CREATED' | 'PARTICIPANT_INVITED' | 'WALLET_CONNECTED' | 'AGREEMENT_SIGNED' | 'ALLOCATION_CHANGED'
  | 'DEAL_LOCKED' | 'DOCUMENT_ADDED' | 'DOCUMENT_ACCEPTED' | 'SETTLEMENT_CREATED' | 'SETTLEMENT_FUNDED' | 'SETTLEMENT_EXECUTING'
  | 'SETTLEMENT_SETTLED' | 'QR_VIEWED' | 'INVITE_CREATED' | 'INVITE_REVOKED' | 'INVITE_REGENERATED' | 'INVITE_OPENED'
  | 'INVITE_CODE_FAILED' | 'INVITE_CODE_VERIFIED' | 'INVITE_BLOCKED' | 'INVITE_EXPIRED' | 'WALLET_CHALLENGE_SIGNED'
  | 'SIGNUP_COMPLETED' | 'INVITE_COMPLETED' | 'VERSION_SUBMITTED' | 'VERSION_REOPENED' | 'VERSION_CREATED'
  | 'SIGNATURES_INVALIDATED' | 'LOGIN' | 'DELETION_REQUESTED' | 'BUSINESS_CREATED' | 'OFFER_CREATED'
  | 'VIEW_LINK_CREATED' | 'VIEW_LINK_REVOKED' | 'VIEW_LINK_ACCESSED';

export interface AuditEntry {
  at: Date;
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  dealId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  wallet?: string | null;
  meta?: Record<string, unknown> | null;
}

// Campos que jamais entram na auditoria (dados de contato e segredos).
const FORBIDDEN_KEYS = /^(email|phone|telefone|token|code|codigo|secret|seed|private_?key|password|senha|full_name|name)$/i;
function scrub(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) out[k] = FORBIDDEN_KEYS.test(k) ? '[omitido]' : scrub(val);
    return out;
  }
  return v;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (at, user_id, action, entity, entity_id, deal_id, old_value, new_value, wallet, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.at.toISOString(), e.userId ?? null, e.action, e.entity, e.entityId ?? null, e.dealId ?? null,
      e.oldValue === undefined ? null : JSON.stringify(scrub(e.oldValue)),
      e.newValue === undefined ? null : JSON.stringify(scrub(e.newValue)),
      e.wallet ?? null, e.meta ? JSON.stringify(scrub(e.meta)) : null],
  );
}

// ---------------------------------------------------------------- rate limit (janela fixa, em memória)
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private now: () => number;
  constructor(now: () => number) { this.now = now; }
  /** Retorna true se permitido. */
  hit(bucket: string, key: string, rule: RateLimitRule): boolean {
    const k = `${bucket}|${key}`;
    const t = this.now();
    const cur = this.hits.get(k);
    if (!cur || cur.reset <= t) {
      this.hits.set(k, { n: 1, reset: t + rule.windowMs });
      if (this.hits.size > 50_000) this.gc(t);
      return true;
    }
    cur.n += 1;
    return cur.n <= rule.max;
  }
  private gc(t: number) { for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k); }
}
