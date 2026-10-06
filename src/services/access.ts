// Solicitação de acesso: como alguém entra na plataforma sem convite — o caso do PRIMEIRO Pay
// Master, que não tem de quem receber convite porque ainda não existe mesa nenhuma.
//
// O que isto é e o que não é:
//  - A solicitação NÃO cria conta. Enquanto está PENDENTE não existe usuário nem carteira
//    registrada, e não há como entrar. Quem cria a conta é o comando `npm run access approve`,
//    rodado por quem opera o servidor depois de olhar quem é a pessoa.
//  - A carteira é COMPROVADA por assinatura no momento da solicitação. Sem isso, qualquer um
//    cadastraria o endereço de outra pessoa — e a aprovação daria acesso a quem não pediu.
//  - As rotas só existem com ACCESS_REQUESTS ligado (ver src/app.ts). Desligado, nem 401: 404.
import type { Queryable } from '../db.ts';
import { HttpError, audit, conflict } from '../lib/common.ts';
import { issueChallenge, consumeChallenge, type Ctx } from './auth.ts';
import { validateSignup, type SignupInput } from './invitations.ts';

export interface AccessRequestInput extends SignupInput {
  organization: string;
  referral?: string | null;
  note?: string | null;
  challengeId: string;
  nonce: string;
  signature: string;
}

export type AccessRequestStatus = 'PENDENTE' | 'APROVADO' | 'RECUSADO';

const trim = (v: unknown, max: number): string => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Desafio para provar a carteira. Não cria nada: só existe para a assinatura seguinte. */
export async function requestChallenge(ctx: Ctx, address: string) {
  return ctx.db.tx((q) => issueChallenge(q, ctx, {
    purpose: 'ACCESS_REQUEST', address,
    context: { Finalidade: 'Solicitar acesso à mesa privada' },
  }));
}

/** Registra a solicitação com a carteira já comprovada. Continua sem conta até alguém aprovar. */
export async function submitRequest(ctx: Ctx, input: AccessRequestInput) {
  const errs = validateSignup(input);
  const organization = trim(input.organization, 120);
  if (organization.length < 2) errs.push('Informe a organização ou mesa que você representa.');
  if (errs.length) throw new HttpError(400, 'VALIDATION', errs.join(' '));

  // Erro vira `failure` para a transação commitar: lançar aqui desfaria o consumo do challenge no
  // rollback e ele voltaria a valer, contra o "uso único mesmo que a assinatura falhe" de
  // consumeChallenge. Mesmo padrão de inviteWalletVerify e signAgreement.
  let failure: HttpError | null = null;
  const out = await ctx.db.tx(async (q) => {
    let ch;
    try { ch = await consumeChallenge(q, ctx, { ...input, purpose: 'ACCESS_REQUEST' }); } catch (e) { failure = e as HttpError; return null; }
    const wallet = ch.wallet_address as string;

    // Quem já tem cadastro não solicita: entra. Dizer isso é melhor do que empilhar uma
    // solicitação que a aprovação depois recusaria por carteira duplicada.
    const { rows: já } = await q.query(`SELECT 1 FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, wallet]);
    if (já.length) { failure = conflict('ALREADY_REGISTERED', 'Esta carteira já tem acesso. Entre pela Verum Wallet.'); return null; }

    const email = String(input.email).trim().toLowerCase();
    const { rows: emailEmUso } = await q.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
    if (emailEmUso.length) { failure = conflict('EMAIL_IN_USE', 'Este e-mail já está vinculado a um cadastro.'); return null; }

    const { rows: pendentes } = await q.query<any>(
      `SELECT wallet, lower(email) AS email FROM access_requests
        WHERE status = 'PENDENTE' AND (wallet = $1 OR lower(email) = $2)`, [wallet, email]);
    if (pendentes.length) {
      failure = conflict('ALREADY_PENDING', 'Já existe uma solicitação em análise para esta carteira ou e-mail. Aguarde o retorno.');
      return null;
    }

    const { rows: [r] } = await q.query<any>(
      `INSERT INTO access_requests (full_name, email, phone, country, organization, referral, note, wallet, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [trim(input.fullName, 120), email, String(input.phone).trim(), input.country, organization,
        trim(input.referral, 120) || null, String(input.note ?? '').trim().slice(0, 500) || null,
        wallet, ctx.cfg.now().toISOString()]);

    // Sem userId: ainda não existe usuário. A auditoria guarda o id da solicitação, não os dados
    // pessoais (o scrub de lib/common.ts já omitiria nome, e-mail e telefone de qualquer forma).
    await audit(q, { at: ctx.cfg.now(), action: 'ACCESS_REQUESTED', entity: 'access_request', entityId: r.id, wallet });
    return { id: r.id as string, status: 'PENDENTE' as AccessRequestStatus };
  });
  if (failure) throw failure;
  return out!;
}

// ---------------------------------------------------------------- uso pelo comando (scripts/access.ts)
export interface AccessRequestRow {
  id: string; full_name: string; email: string; phone: string; country: string;
  organization: string; referral: string | null; note: string | null; wallet: string;
  status: AccessRequestStatus; user_id: string | null;
  created_at: string; decided_at: string | null; decided_by: string | null; decision_note: string | null;
}

export async function listRequests(q: Queryable, status?: AccessRequestStatus): Promise<AccessRequestRow[]> {
  const { rows } = await q.query<AccessRequestRow>(
    `SELECT * FROM access_requests ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC`,
    status ? [status] : []);
  return rows;
}

/** Acha a solicitação por id, e-mail ou carteira. Exige que seja uma só, para o comando não decidir por você. */
export async function findRequest(q: Queryable, alvo: string): Promise<AccessRequestRow> {
  const v = String(alvo ?? '').trim();
  const { rows } = await q.query<AccessRequestRow>(
    `SELECT * FROM access_requests
      WHERE (CASE WHEN $1 ~ '^[0-9a-f-]{36}$' THEN id::text = $1 ELSE false END)
         OR lower(email) = lower($1) OR wallet = $1
      ORDER BY created_at DESC`, [v]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', `Nenhuma solicitação encontrada para "${v}".`);
  const pendentes = rows.filter((r) => r.status === 'PENDENTE');
  if (pendentes.length > 1) throw conflict('AMBIGUOUS', `"${v}" casa com ${pendentes.length} solicitações pendentes. Use o id.`);
  return pendentes[0] ?? rows[0];
}

/**
 * Aprova: cria usuário + carteira numa transação e marca a solicitação. É o ÚNICO caminho do
 * sistema que cria conta sem convite, e por isso só roda por comando, nunca por rota HTTP.
 *
 * A conta nasce com origin='INVITE' (de propósito): quem é aprovado aqui é um Pay Master, abre
 * mesa e convida. Diferente do cadastro por link de visualização, que nasce 'VIEW_LINK' e só lê.
 */
export async function approveRequest(ctx: Ctx, alvo: string, por: string) {
  return ctx.db.tx(async (q) => {
    const r = await findRequest(q, alvo);
    if (r.status !== 'PENDENTE') throw conflict('ALREADY_DECIDED', `Solicitação já está ${r.status}.`);

    const { rows: wDup } = await q.query(`SELECT 1 FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, r.wallet]);
    if (wDup.length) throw conflict('WALLET_IN_USE', 'Esta carteira já pertence a um cadastro. Recuse a solicitação.');
    const { rows: eDup } = await q.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [r.email]);
    if (eDup.length) throw conflict('EMAIL_IN_USE', 'Este e-mail já pertence a um cadastro. Recuse a solicitação.');

    const agora = ctx.cfg.now().toISOString();
    const { rows: [u] } = await q.query<any>(
      `INSERT INTO users (full_name, email, phone, country, is_demo, origin, terms_accepted_at, created_at)
       VALUES ($1,$2,$3,$4,false,'INVITE',$5,$5) RETURNING id`,
      [r.full_name, r.email, r.phone, r.country, agora]);
    await q.query(`INSERT INTO wallets (user_id, network, address, provider, created_at) VALUES ($1,$2,$3,'verum-wallet',$4)`,
      [u.id, ctx.sig.network, r.wallet, agora]);
    await q.query(
      `UPDATE access_requests SET status = 'APROVADO', user_id = $2, decided_at = $3, decided_by = $4 WHERE id = $1`,
      [r.id, u.id, agora, trim(por, 120) || 'operador']);

    await audit(q, { at: ctx.cfg.now(), userId: u.id, action: 'SIGNUP_COMPLETED', entity: 'user', entityId: u.id, wallet: r.wallet });
    await audit(q, { at: ctx.cfg.now(), userId: u.id, action: 'ACCESS_APPROVED', entity: 'access_request', entityId: r.id, wallet: r.wallet });
    return { request: r, userId: u.id as string };
  });
}

export async function rejectRequest(ctx: Ctx, alvo: string, por: string, motivo: string | null) {
  return ctx.db.tx(async (q) => {
    const r = await findRequest(q, alvo);
    if (r.status !== 'PENDENTE') throw conflict('ALREADY_DECIDED', `Solicitação já está ${r.status}.`);
    await q.query(
      `UPDATE access_requests SET status = 'RECUSADO', decided_at = $2, decided_by = $3, decision_note = $4 WHERE id = $1`,
      [r.id, ctx.cfg.now().toISOString(), trim(por, 120) || 'operador', motivo ? String(motivo).trim().slice(0, 500) : null]);
    await audit(q, { at: ctx.cfg.now(), action: 'ACCESS_REJECTED', entity: 'access_request', entityId: r.id, wallet: r.wallet });
    return r;
  });
}

/** Descarte de solicitações recusadas antigas: dado pessoal de quem não entrou não fica para sempre (LGPD). */
export async function purgeRejected(ctx: Ctx, dias: number) {
  const limite = new Date(ctx.cfg.now().getTime() - dias * 86_400_000).toISOString();
  const { rows } = await ctx.db.query<any>(
    `DELETE FROM access_requests WHERE status = 'RECUSADO' AND decided_at < $1 RETURNING id`, [limite]);
  return rows.length;
}
