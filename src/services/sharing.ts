// Link de visualização da mesa: um por mesa, só leitura, gerado e revogado pelo admin.
//
// Duas regras moldam tudo aqui:
//  1. Quem abre o link se identifica ANTES de ver a operação (padrão NCNDA). O portão devolve só o
//     cabeçalho da mesa — código, título, direção — e nada de participantes, percentuais ou
//     documentos vaza antes do cadastro.
//  2. Visualizador não age. Só existem rotas GET sob /api/shared/:token; nenhuma rota de escrita
//     aceita token, então não há caminho para assinar, convidar ou alterar seja o que for.
import type { Queryable } from '../db.ts';
import { HttpError, audit, notFound } from '../lib/common.ts';
import { abbreviateAddress, newToken } from '../lib/crypto.ts';
import { assertDealAdmin } from './deals.ts';
import { validateSignup, type SignupInput } from './invitations.ts';
import { issueChallenge, consumeChallenge, type Ctx } from './auth.ts';

/** Cookie que guarda a carteira já provada pelo link, até a identificação ser concluída. */
export const VIEW_COOKIE = 'votc_view';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const COUNTRY_LABEL: Record<string, string> = {
  BR: 'Brasil', PY: 'Paraguai', AR: 'Argentina', UY: 'Uruguai', US: 'Estados Unidos',
  PT: 'Portugal', AE: 'Emirados Árabes', CH: 'Suíça',
};

const linkUrl = (ctx: Ctx, token: string) => `${ctx.cfg.publicOrigin}/#/m/${token}`;

// ---------------------------------------------------------------- admin da mesa
/** Link atual, se existir. Exclusivo do admin: é ele quem compartilha e quem revoga. */
export async function viewLink(ctx: Ctx, userId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, userId);
    const { rows: [d] } = await q.query<any>(`SELECT view_token FROM deals WHERE id = $1`, [dealId]);
    return d.view_token
      ? { token: d.view_token, url: linkUrl(ctx, d.view_token), exists: true }
      : { token: null, url: null, exists: false };
  });
}

/** Cria o link se ainda não houver. Repetir não troca o token: o admin reexibe o MESMO link. */
export async function createViewLink(ctx: Ctx, userId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, userId);
    const { rows: [d] } = await q.query<any>(`SELECT view_token FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    if (d.view_token) return { token: d.view_token, url: linkUrl(ctx, d.view_token), exists: true };
    const token = newToken();
    await q.query(`UPDATE deals SET view_token = $2 WHERE id = $1`, [dealId, token]);
    await audit(q, { at: ctx.cfg.now(), userId, action: 'VIEW_LINK_CREATED', entity: 'deal', entityId: dealId, dealId });
    return { token, url: linkUrl(ctx, token), exists: true };
  });
}

/** Troca o token: o link anterior para de funcionar na hora. Quem já se identificou continua. */
export async function regenerateViewLink(ctx: Ctx, userId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, userId);
    await q.query(`SELECT view_token FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const token = newToken();
    await q.query(`UPDATE deals SET view_token = $2 WHERE id = $1`, [dealId, token]);
    await audit(q, { at: ctx.cfg.now(), userId, action: 'VIEW_LINK_REVOKED', entity: 'deal', entityId: dealId, dealId });
    return { token, url: linkUrl(ctx, token), exists: true };
  });
}

/** Quem abriu o link. Exclusivo do admin — é a ele que a identificação se destina. */
export async function listViewers(ctx: Ctx, userId: string, dealId: string) {
  return ctx.db.tx(async (q) => {
    await assertDealAdmin(q, dealId, userId);
    const { rows: [d] } = await q.query<any>(`SELECT view_token FROM deals WHERE id = $1`, [dealId]);
    const { rows } = await q.query<any>(
      `SELECT v.id, v.full_name, v.email, v.phone, v.country, v.wallet, v.at,
              EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = v.deal_id AND dp.user_id = v.user_id) AS is_participant
         FROM deal_viewers v WHERE v.deal_id = $1 ORDER BY v.at DESC`, [dealId]);
    return {
      hasLink: !!d.view_token,
      viewers: rows.map((r) => ({
        id: r.id, name: r.full_name, email: r.email, phone: r.phone, country: r.country,
        countryLabel: COUNTRY_LABEL[r.country] ?? r.country,
        wallet: r.wallet, walletShort: abbreviateAddress(r.wallet), at: r.at,
        isParticipant: r.is_participant,
      })),
    };
  });
}

// ---------------------------------------------------------------- quem abre o link
/** Resolve o token. Mensagem única para token inexistente ou revogado: não revela qual é o caso. */
export async function dealByToken(q: Queryable, token: string): Promise<{ id: string }> {
  if (!TOKEN_RE.test(String(token ?? ''))) throw notFound('Este link de visualização não é mais válido.');
  const { rows } = await q.query<any>(`SELECT id FROM deals WHERE view_token = $1`, [token]);
  if (!rows[0]) throw notFound('Este link de visualização não é mais válido.');
  return { id: rows[0].id };
}

/**
 * Libera a leitura: admin e participantes já têm acesso próprio; os demais precisam ter se
 * identificado NESTA mesa. Devolve o userId quando quem chama é membro — aí a mesa é vista com o
 * olhar dele — e null quando é visualizador, que é o que apaga ações, contatos e o "eu".
 */
export async function assertViewer(q: Queryable, dealId: string, userId: string): Promise<string | null> {
  const { rows: [d] } = await q.query<any>(
    `SELECT d.admin_user_id = $2 AS is_admin,
            EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.user_id = $2) AS member,
            EXISTS (SELECT 1 FROM deal_viewers v WHERE v.deal_id = d.id AND v.user_id = $2) AS viewer
       FROM deals d WHERE d.id = $1`, [dealId, userId]);
  if (!d) throw notFound('Operação não encontrada.');
  if (d.is_admin || d.member) return userId;
  if (d.viewer) return null;
  throw new HttpError(403, 'VIEWER_REGISTRATION_REQUIRED', 'Identifique-se para abrir esta operação.');
}

/**
 * Portão: só o cabeçalho da mesa, para a pessoa saber o que está abrindo antes de se identificar.
 * userId null = carteira provada pelo link mas ainda sem cadastro — nada a pré-preencher.
 */
export async function viewerGate(ctx: Ctx, userId: string | null, address: string, token: string) {
  return ctx.db.tx(async (q) => {
    const { id: dealId } = await dealByToken(q, token);
    const { rows: [d] } = await q.query<any>(
      `SELECT d.id, d.code, o.kind, o.title, b.name AS business_name,
              (SELECT asset_id FROM offer_legs WHERE offer_id = o.id AND side = 'ENTREGA') AS deliver_asset,
              (SELECT asset_id FROM offer_legs WHERE offer_id = o.id AND side = 'RECEBIMENTO') AS receive_asset,
              d.admin_user_id = $2 AS is_admin,
              EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.user_id = $2) AS member,
              EXISTS (SELECT 1 FROM deal_viewers v WHERE v.deal_id = d.id AND v.user_id = $2) AS viewer
         FROM deals d JOIN offers o ON o.id = d.offer_id LEFT JOIN businesses b ON b.id = o.business_id
        WHERE d.id = $1`, [dealId, userId]);
    const { rows: [u] } = await q.query<any>(`SELECT full_name, email, phone, country FROM users WHERE id = $1`, [userId]);
    const sym = (id: string | null) => (id ? ctx.assets.byId(id)?.symbol ?? id : '?');
    return {
      registered: Boolean(d.is_admin || d.member || d.viewer),
      wallet: address, walletShort: abbreviateAddress(address),
      prefill: u ? { fullName: u.full_name, email: u.email, phone: u.phone, country: u.country } : null,
      deal: {
        code: d.code, title: d.title, businessName: d.business_name,
        kindLabel: d.kind === 'UNICA' ? 'OFERTA ÚNICA' : 'PARCERIA PERMANENTE',
        direction: `${sym(d.deliver_asset)} → ${sym(d.receive_asset)}`,
      },
    };
  });
}

/**
 * Identificação de quem abriu o link. Os dados são declarados; só a carteira é verificada.
 *
 * userId null = carteira provada pelo link mas ainda sem cadastro: cria o usuário aqui. Isso NÃO
 * é cadastro público — exige um link secreto emitido pelo admin da mesa — e não dá pertencimento
 * a mesa nenhuma: o cadastro só serve para ler a operação onde a pessoa se identificou.
 */
export async function registerViewer(ctx: Ctx, userId: string | null, address: string, token: string, input: SignupInput) {
  const errs = validateSignup(input);
  if (errs.length) throw new HttpError(400, 'VALIDATION', errs.join(' '));
  return ctx.db.tx(async (q) => {
    const { id: dealId } = await dealByToken(q, token);
    const nome = String(input.fullName).trim().replace(/\s+/g, ' ');
    const email = String(input.email).trim().toLowerCase();
    const telefone = String(input.phone).trim();
    let uid = userId;
    if (uid === null) {
      const { rows: emailDup } = await q.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
      if (emailDup.length) throw new HttpError(409, 'EMAIL_IN_USE', 'Este e-mail já está vinculado a outra carteira.');
      // Corrida: duas abas provando a mesma carteira. A segunda encontra o cadastro e segue com ele.
      const { rows: wDup } = await q.query<any>(`SELECT user_id FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, address]);
      if (wDup[0]) uid = wDup[0].user_id;
      else {
        const { rows: [u] } = await q.query<any>(
          `INSERT INTO users (full_name, email, phone, country, is_demo, origin, terms_accepted_at, created_at)
           VALUES ($1,$2,$3,$4,$5,'VIEW_LINK',$6,$6) RETURNING id`,
          [nome, email, telefone, input.country, ctx.cfg.demoMode, ctx.cfg.now().toISOString()]);
        uid = u.id as string;
        await q.query(`INSERT INTO wallets (user_id, network, address, created_at) VALUES ($1,$2,$3,$4)`,
          [uid, ctx.sig.network, address, ctx.cfg.now().toISOString()]);
        await audit(q, { at: ctx.cfg.now(), userId: uid, action: 'SIGNUP_COMPLETED', entity: 'user', entityId: uid, dealId, wallet: address });
      }
    }
    const { rows: dup } = await q.query(`SELECT 1 FROM deal_viewers WHERE deal_id = $1 AND user_id = $2`, [dealId, uid]);
    if (dup.length) throw new HttpError(409, 'ALREADY_REGISTERED', 'Você já se identificou para esta operação.');
    await q.query(
      `INSERT INTO deal_viewers (deal_id, user_id, full_name, email, phone, country, wallet, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [dealId, uid, nome, email, telefone, input.country, address, ctx.cfg.now().toISOString()]);
    await audit(q, { at: ctx.cfg.now(), userId: uid, action: 'VIEW_LINK_ACCESSED', entity: 'deal', entityId: dealId, dealId, wallet: address });
    return { ok: true, userId: uid as string };
  });
}

// ---------------------------------------------------------------- entrar pelo link, sem convite
/** Desafio para provar a carteira. Só existe para quem tem um link válido na mão. */
export async function viewerChallenge(ctx: Ctx, token: string, address: string) {
  return ctx.db.tx(async (q) => {
    const { id: dealId } = await dealByToken(q, token);
    const { rows: [d] } = await q.query<any>(`SELECT code FROM deals WHERE id = $1`, [dealId]);
    return issueChallenge(q, ctx, {
      purpose: 'VIEW_LINK', address,
      context: { 'Operação': d.code, Finalidade: 'Abrir link de visualização (só leitura)' },
    });
  });
}

/**
 * Consome o desafio e diz quem é. Carteira com cadastro entra direto; carteira nova segue para a
 * identificação, e é lá que o cadastro nasce — aqui nada é criado.
 */
export async function viewerVerify(ctx: Ctx, token: string, input: { challengeId: string; nonce: string; signature: string }) {
  return ctx.db.tx(async (q) => {
    await dealByToken(q, token);
    const ch = await consumeChallenge(q, ctx, { ...input, purpose: 'VIEW_LINK' });
    const { rows } = await q.query<any>(`SELECT user_id FROM wallets WHERE network = $1 AND address = $2`, [ctx.sig.network, ch.wallet_address]);
    return { address: ch.wallet_address as string, userId: (rows[0]?.user_id as string) ?? null };
  });
}
