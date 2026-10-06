import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.ts';
import { openDb, dbErrorCode, type Db } from './db.ts';
import { sha256Hex } from './lib/crypto.ts';
import { HttpError, RateLimiter, audit, notFound } from './lib/common.ts';
import { distribute, formatUnits } from './lib/bps.ts';
import {
  AssetAdapter, SolanaSignatureAdapter, DemoSettlementAdapter, defaultAssetRegistry, qrAdapterFor, WALLET_ATTESTATION_AVAILABLE,
} from './adapters/index.ts';
import {
  type Ctx, SESSION_COOKIE, makeSessionCookie, readSessionCookie, loginChallenge, loginVerify, type Session,
} from './services/auth.ts';
import * as inv from './services/invitations.ts';
import * as deals from './services/deals.ts';
import * as ps from './services/partnership.ts';
import { seedDemo, personaDirectory } from './demo.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---------------------------------------------------------------- schemas
const S = {
  token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  uuid: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
  address: { type: 'string', minLength: 32, maxLength: 44, pattern: '^[1-9A-HJ-NP-Za-km-z]+$' },
  b58: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[1-9A-HJ-NP-Za-km-z]+$' },
};
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const signed = obj({ challengeId: S.uuid, nonce: S.b58, signature: S.b58 });
const roleEnum = { type: 'string', enum: deals.ROLE_KEYS };

export interface BuiltApp { app: FastifyInstance; ctx: Ctx; db: Db }

export async function buildApp(opts: { config?: Partial<AppConfig>; env?: NodeJS.ProcessEnv; seed?: boolean; logger?: boolean } = {}): Promise<BuiltApp> {
  const cfg = loadConfig(opts.env ?? process.env, opts.config ?? {});
  const db = await openDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir });
  const assets = new AssetAdapter(defaultAssetRegistry(), cfg.mainnetEnabled);
  const ctx: Ctx = {
    db, cfg, assets,
    sig: new SolanaSignatureAdapter(cfg.network),
    settlement: new DemoSettlementAdapter(),
    limiter: new RateLimiter(() => cfg.now().getTime()),
  };
  await syncAssets(ctx);
  // Banco local: semeia o DEMO no boot, como sempre. Banco compartilhado: semear no boot deixaria
  // dois processos subindo juntos criarem as mesas DEMO em duplicata — ali o seed é passo explícito
  // do deploy ("npm run db:setup"). opts.seed força qualquer um dos dois.
  if (cfg.demoMode && (opts.seed ?? db.kind === 'pglite')) await seedDemo(ctx);

  const app = Fastify({
    logger: opts.logger ? {
      level: 'info',
      serializers: {
        // Nenhum token de convite nem dado pessoal em log: só método e rota redigida.
        req: (r: any) => ({ method: r.method, url: String(r.url).replace(/\/i\/[^/?#]+/, '/i/[redigido]').split('?')[0] }),
        res: (r: any) => ({ statusCode: r.statusCode }),
      },
    } : false,
    bodyLimit: 3.5 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  await app.register(cookie);

  // ---------------------------------------------------------------- headers de segurança
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
      "manifest-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
    ].join('; '));
    if (cfg.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api') || req.url.startsWith('/invite') || req.url.startsWith('/auth') || req.url.startsWith('/invitations')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // ---------------------------------------------------------------- erros
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err as any).remaining !== undefined ? { remaining: (err as any).remaining } : {} });
    }
    if (err.validation) return reply.status(400).send({ error: 'VALIDATION', message: 'Dados inválidos ou campos não permitidos.' });
    if (err.statusCode === 413) return reply.status(413).send({ error: 'TOO_LARGE', message: 'Conteúdo acima do limite.' });
    const code = dbErrorCode(err);
    if (code && ['LOCKED_VERSION', 'VERSION_IMMUTABLE', 'INVITE_IMMUTABLE', 'INVITE_TERMINAL', 'INVALID_TRANSITION', 'BPS_SUM_MISMATCH', 'SIGNATURES_INCOMPLETE', 'INVITE_REQUIRES_DRAFT', 'SETTLEMENT_REQUIRES_LOCKED'].includes(code)) {
      return reply.status(409).send({ error: code, message: 'Operação recusada pelas regras de integridade da parceria.' });
    }
    req.log?.error({ errCode: code ?? err.code ?? 'UNEXPECTED' }, 'erro inesperado');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Erro interno. Nenhuma alteração parcial foi gravada.' });
  });

  // ---------------------------------------------------------------- helpers
  const ip = (req: FastifyRequest) => req.ip ?? 'unknown';
  const limit = (bucket: keyof AppConfig['rateLimits'], ...keys: string[]) => {
    for (const k of keys) {
      if (!ctx.limiter.hit(bucket, k, cfg.rateLimits[bucket])) throw new HttpError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde um minuto.');
    }
  };
  const cookieBase = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict' as const, path: '/' };
  const setSession = (reply: FastifyReply, uid: string, addr: string, startedAt?: number) => {
    const c = makeSessionCookie(ctx, uid, addr, startedAt);
    reply.setCookie(SESSION_COOKIE, c.value, { ...cookieBase, maxAge: c.maxAgeSec });
  };
  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<Session> => {
    const s = readSessionCookie(ctx, req.cookies[SESSION_COOKIE]);
    if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'Sessão expirada. Entre com a Verum Wallet.');
    setSession(reply, s.uid, s.addr, s.iat); // renovação deslizante até o limite absoluto
    return s;
  };
  const inviteCookie = (req: FastifyRequest) => req.cookies[inv.INVITE_COOKIE];
  const tokenKey = (t: string) => sha256Hex(String(t)).slice(0, 32);

  // ---------------------------------------------------------------- páginas
  const indexHtml = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  // GET/HEAD do link: tela genérica, NÃO consome, não revela dados. Robôs de prévia recebem o mesmo.
  app.get('/i/:token', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    reply.type('text/html; charset=utf-8');
    return indexHtml
      .replace('<meta name="robots" content="noindex">', '<meta name="robots" content="noindex, nofollow, noarchive">')
      .replace(/<title>[^<]*<\/title>/, '<title>Convite privado VERUM NCNDA</title>');
  });
  await app.register(fstatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'], cacheControl: true, maxAge: 0 });

  // ---------------------------------------------------------------- configuração pública
  app.get('/api/config', async () => ({
    demoMode: cfg.demoMode, network: cfg.network, mainnetEnabled: false,
    walletDownloadUrl: cfg.verumWalletDownloadUrl || null,
    resumeWindowMinutes: cfg.resumeWindowMinutes, onboardingTtlMinutes: cfg.onboardingTtlMinutes,
    walletAttestationAvailable: WALLET_ATTESTATION_AVAILABLE,
    walletDeepLinkAvailable: false,
    settlement: { adapter: ctx.settlement.id, demo: ctx.settlement.demo, protectedByContract: ctx.settlement.protectedByContract },
  }));
  if (cfg.demoMode) app.get('/api/demo/personas', async () => ({ personas: personaDirectory(), warning: 'DEMO — chaves derivadas de sementes públicas. NO REAL FUNDS.' }));

  // ---------------------------------------------------------------- convite: fluxo do parceiro
  app.post('/invite/open', { schema: { body: obj({ token: S.token }) } }, async (req: any, reply) => {
    limit('open', `ip:${ip(req)}`, `inv:${tokenKey(req.body.token)}`);
    const r = await inv.openInvitation(ctx, req.body.token);
    reply.setCookie(inv.INVITE_COOKIE, r.cookie.value, { ...cookieBase, path: '/invite', maxAge: r.cookie.maxAgeSec });
    return { step: 'CHOICE', walletDownloadUrl: r.walletDownloadUrl };
  });
  app.post('/invite/resume', { schema: { body: obj({ token: S.token }) } }, async (req: any) => {
    limit('resume', `ip:${ip(req)}`);
    return inv.resumeInvitation(ctx, req.body.token, inviteCookie(req));
  });
  app.post('/invite/verify-code', { schema: { body: obj({ token: S.token, code: { type: 'string', maxLength: 20 } }) } }, async (req: any) => {
    limit('verifyCode', `ip:${ip(req)}`, `inv:${tokenKey(req.body.token)}`);
    return inv.verifyInviteCode(ctx, req.body.token, inviteCookie(req), req.body.code);
  });
  app.post('/invite/wallet-challenge', { schema: { body: obj({ token: S.token, address: S.address }) } }, async (req: any) => {
    limit('walletChallenge', `ip:${ip(req)}`, `inv:${tokenKey(req.body.token)}`);
    const c = await inv.inviteWalletChallenge(ctx, req.body.token, inviteCookie(req), req.body.address);
    return { challengeId: c.challengeId, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  });
  app.post('/invite/wallet-verify', { schema: { body: obj({ token: S.token, challengeId: S.uuid, nonce: S.b58, signature: S.b58 }) } }, async (req: any) => {
    limit('walletVerify', `ip:${ip(req)}`, `inv:${tokenKey(req.body.token)}`);
    const { token, ...rest } = req.body;
    return inv.inviteWalletVerify(ctx, token, inviteCookie(req), rest);
  });
  app.post('/invite/signup', {
    schema: { body: obj({ token: S.token, fullName: { type: 'string', maxLength: 120 }, email: { type: 'string', maxLength: 254 }, phone: { type: 'string', maxLength: 24 }, country: { type: 'string', maxLength: 2 } }) },
  }, async (req: any) => {
    const { token, ...rest } = req.body;
    return inv.inviteSignup(ctx, token, inviteCookie(req), rest);
  });
  app.post('/invite/complete', { schema: { body: obj({ token: S.token, acceptTerms: { type: 'boolean', const: true } }) } }, async (req: any, reply) => {
    const r = await inv.inviteComplete(ctx, req.body.token, inviteCookie(req));
    reply.clearCookie(inv.INVITE_COOKIE, { path: '/invite' });
    setSession(reply, r.userId, r.address);
    return { dealId: r.dealId };
  });

  // ---------------------------------------------------------------- convite: admin
  app.post('/invitations', { schema: { body: obj({ dealId: S.uuid, roleKey: roleEnum, roleSeq: { type: 'integer', minimum: 1, maximum: 9 }, ttlHours: { type: 'integer', minimum: 1, maximum: 720 } }, ['dealId', 'roleKey']) } },
    async (req: any, reply) => { const s = await auth(req, reply); return inv.createInvitation(ctx, s.uid, req.body); });
  app.get('/invitations', { schema: { querystring: obj({ dealId: S.uuid }, []) } },
    async (req: any, reply) => { const s = await auth(req, reply); return { invitations: await inv.listInvitations(ctx, s.uid, req.query.dealId) }; });
  app.post('/invitations/:id/revoke', async (req: any, reply) => { const s = await auth(req, reply); return inv.revokeInvitation(ctx, s.uid, req.params.id); });
  app.post('/invitations/:id/regenerate', async (req: any, reply) => { const s = await auth(req, reply); return inv.regenerateInvitation(ctx, s.uid, req.params.id); });

  // ---------------------------------------------------------------- login sem senha
  app.post('/auth/wallet-challenge', { schema: { body: obj({ address: S.address }) } }, async (req: any) => {
    limit('authChallenge', `ip:${ip(req)}`);
    const c = await loginChallenge(ctx, req.body.address);
    return { challengeId: c.challengeId, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  });
  app.post('/auth/wallet-verify', { schema: { body: signed } }, async (req: any, reply) => {
    limit('authVerify', `ip:${ip(req)}`);
    const r = await loginVerify(ctx, req.body);
    setSession(reply, r.userId, r.address);
    return { ok: true };
  });
  app.post('/auth/logout', async (_req, reply) => { reply.clearCookie(SESSION_COOKIE, { path: '/' }); return { ok: true }; });

  // ---------------------------------------------------------------- área autenticada
  app.get('/api/me', async (req, reply) => { const s = await auth(req, reply); return ps.profile(ctx, s.uid); });
  app.post('/api/me/deletion-request', async (req, reply) => { const s = await auth(req, reply); return ps.requestDeletion(ctx, s.uid); });
  app.get('/api/assets', async (req, reply) => {
    await auth(req, reply);
    return { assets: assets.list().map((a) => ({ ...a, selectable: a.status === 'ACTIVE' && (a.environment === 'OFFCHAIN' || a.environment === (cfg.network === 'solana-devnet' ? 'DEVNET' : 'DEMO')) })) };
  });
  app.get('/api/dashboard', async (req, reply) => { const s = await auth(req, reply); return ctx.db.tx((q) => deals.dashboard(q, ctx, s.uid)); });
  app.get('/api/deals', async (req, reply) => { const s = await auth(req, reply); return { deals: await ctx.db.tx((q) => deals.listDeals(q, ctx, s.uid)) }; });
  app.get('/api/businesses', async (req, reply) => {
    const s = await auth(req, reply);
    const { rows } = await db.query<any>(`SELECT id, name, tagline FROM businesses WHERE admin_user_id = $1 ORDER BY created_at`, [s.uid]);
    return { businesses: rows };
  });
  app.post('/api/deals', {
    schema: {
      body: obj({
        kind: { type: 'string', enum: ['UNICA', 'PERMANENTE'] }, title: { type: 'string', minLength: 2, maxLength: 80 },
        businessId: S.uuid, businessName: { type: 'string', maxLength: 80 }, businessTagline: { type: 'string', maxLength: 140 },
        deliverAssetId: { type: 'string', maxLength: 40 }, receiveAssetId: { type: 'string', maxLength: 40 },
        deliverDescription: { type: 'string', maxLength: 80 }, receiveDescription: { type: 'string', maxLength: 80 },
        volumeText: { type: 'string', minLength: 1, maxLength: 80 }, referenceAmount: { type: 'string', maxLength: 40 },
        referenceAssetId: { type: 'string', maxLength: 40 }, grade: { type: 'string', maxLength: 15 },
        conditions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 120 } },
        validUntil: { type: 'string', format: 'date-time' },
        roles: { type: 'array', maxItems: 7, items: roleEnum }, payMasters: { type: 'integer', minimum: 1, maximum: 2 },
        residualPolicy: { type: 'string', enum: ['TO_PAY_MASTER', 'TO_PAYER', 'TO_SELL_INTERMEDIARY', 'TO_BUY_INTERMEDIARY'] },
      }, ['kind', 'title', 'deliverAssetId', 'receiveAssetId', 'volumeText', 'grade']),
    },
  }, async (req: any, reply) => { const s = await auth(req, reply); return ps.createOffer(ctx, s.uid, req.body, { isDemo: cfg.demoMode }); });

  app.get('/api/deals/:id', async (req: any, reply) => { const s = await auth(req, reply); return ctx.db.tx((q) => deals.dealView(q, ctx, req.params.id, s.uid)); });
  app.get('/api/deals/:id/history', async (req: any, reply) => { const s = await auth(req, reply); return { events: await ctx.db.tx((q) => deals.dealHistory(q, req.params.id, s.uid)) }; });
  app.get('/api/deals/:id/compliance', async (req: any, reply) => { const s = await auth(req, reply); return ps.complianceView(ctx, s.uid, req.params.id); });

  const lineSchema = obj({
    lineKey: { type: 'string', pattern: '^[a-z0-9_]{1,40}$' }, label: { type: 'string', minLength: 1, maxLength: 60 },
    roleKey: { anyOf: [roleEnum, { type: 'null' }] }, roleSeq: { type: 'integer', minimum: 1, maximum: 9 },
    bps: { type: 'integer', minimum: 0, maximum: 10000 }, kind: { type: 'string', enum: ['PAGADOR', 'GRUPO_VENDA', 'GRUPO_COMPRA', 'INTERMEDIACAO', 'COMISSAO', 'RESIDUO'] },
  }, ['lineKey', 'label', 'roleKey', 'bps', 'kind']);
  app.put('/api/deals/:id/lines', { schema: { body: obj({ lines: { type: 'array', minItems: 1, maxItems: 30, items: lineSchema }, residualPolicy: { type: 'string', enum: ['TO_PAY_MASTER', 'TO_PAYER', 'TO_SELL_INTERMEDIARY', 'TO_BUY_INTERMEDIARY'] } }, ['lines']) } },
    async (req: any, reply) => { const s = await auth(req, reply); return ps.updateLines(ctx, s.uid, req.params.id, req.body); });
  app.post('/api/deals/:id/slots', { schema: { body: obj({ roleKey: roleEnum }) } }, async (req: any, reply) => { const s = await auth(req, reply); return ps.addSlot(ctx, s.uid, req.params.id, req.body.roleKey); });
  app.delete('/api/deals/:id/slots/:pid', async (req: any, reply) => { const s = await auth(req, reply); return ps.removeSlot(ctx, s.uid, req.params.id, req.params.pid); });
  app.post('/api/deals/:id/slots/:pid/vacate', async (req: any, reply) => { const s = await auth(req, reply); return ps.vacateSlot(ctx, s.uid, req.params.id, req.params.pid); });
  app.post('/api/deals/:id/submit', async (req: any, reply) => { const s = await auth(req, reply); return ps.submitForSignatures(ctx, s.uid, req.params.id); });
  app.post('/api/deals/:id/reopen', async (req: any, reply) => { const s = await auth(req, reply); return ps.reopenDraft(ctx, s.uid, req.params.id); });
  app.post('/api/deals/:id/new-version', async (req: any, reply) => { const s = await auth(req, reply); return ps.createNewVersion(ctx, s.uid, req.params.id); });
  app.post('/api/deals/:id/agreement/challenge', async (req: any, reply) => {
    const s = await auth(req, reply);
    const c = await ps.agreementChallenge(ctx, s.uid, req.params.id);
    return { challengeId: c.challengeId, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  });
  app.post('/api/deals/:id/agreement/sign', { schema: { body: signed } }, async (req: any, reply) => { const s = await auth(req, reply); return ps.signAgreement(ctx, s.uid, req.params.id, req.body); });

  // ---------------------------------------------------------------- QR de pagamento
  app.get('/api/deals/:id/qr/:pid', async (req: any, reply) => {
    const s = await auth(req, reply);
    return ctx.db.tx(async (q) => {
      const view = await deals.dealView(q, ctx, req.params.id, s.uid);
      const p = view.participants.find((x) => x.id === req.params.pid);
      if (!p || !p.wallet) throw notFound('Parceiro sem carteira cadastrada.');
      const recvAsset = view.offer.reference ? assets.byId(view.offer.reference.assetId) : null;
      let amount: bigint | null = null;
      if (view.offer.reference && view.linesValidation.ok) {
        const dist = distribute(BigInt(view.offer.reference.amount), view.lines, view.version.gradeTotalBps, view.version.residualPolicy);
        amount = dist.lines.filter((l) => l.roleKey === p.roleKey && l.roleSeq === p.seq).reduce((a, l) => a + l.amount, 0n);
        if (amount === 0n) amount = null;
      }
      const network = recvAsset?.network ?? cfg.network;
      const payload = qrAdapterFor(network).build({
        recipient: p.wallet, asset: recvAsset, amount, label: 'VERUM NCNDA', message: `${view.code} ${p.role}`,
      });
      await audit(q, { at: cfg.now(), userId: s.uid, action: 'QR_VIEWED', entity: 'partnership_participant', entityId: p.id, dealId: view.id });
      return {
        uri: payload.uri, format: payload.format, demo: payload.demo,
        network, asset: recvAsset ? { id: recvAsset.id, symbol: recvAsset.symbol } : null,
        amount: amount?.toString() ?? null, amountLabel: amount && recvAsset ? `${formatUnits(amount, recvAsset.decimals)} ${recvAsset.symbol}` : null,
        address: p.wallet, addressShort: p.walletShort, name: p.name, role: p.role,
        payment: view.payment, deepLink: null,
      };
    });
  });

  // ---------------------------------------------------------------- documentos
  app.get('/api/deals/:id/documents', async (req: any, reply) => { const s = await auth(req, reply); return { documents: await ps.listDocuments(ctx, s.uid, req.params.id) }; });
  app.post('/api/deals/:id/documents', {
    schema: { body: obj({ name: { type: 'string', maxLength: 120 }, documentId: S.uuid, mime: { type: 'string', maxLength: 100 }, contentBase64: { type: 'string', maxLength: 2_900_000 }, requiresAcceptance: { type: 'boolean' } }, ['mime', 'contentBase64']) },
  }, async (req: any, reply) => { const s = await auth(req, reply); return ps.addDocument(ctx, s.uid, req.params.id, req.body); });
  app.get('/api/deals/:id/documents/:vid/content', async (req: any, reply) => {
    const s = await auth(req, reply);
    const d = await ps.documentContent(ctx, s.uid, req.params.id, req.params.vid);
    reply.header('Content-Disposition', `attachment; filename="${d.filename}"`);
    reply.type('application/octet-stream');
    return d.content;
  });
  app.post('/api/deals/:id/documents/:vid/challenge', async (req: any, reply) => {
    const s = await auth(req, reply);
    const c = await ps.documentChallenge(ctx, s.uid, req.params.id, req.params.vid);
    return { challengeId: c.challengeId, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  });
  app.post('/api/deals/:id/documents/:vid/accept', { schema: { body: signed } }, async (req: any, reply) => { const s = await auth(req, reply); return ps.acceptDocument(ctx, s.uid, req.params.id, req.params.vid, req.body); });

  // ---------------------------------------------------------------- settlement
  app.get('/api/deals/:id/settlement/preview', async (req: any, reply) => { const s = await auth(req, reply); return ps.settlementPreview(ctx, s.uid, req.params.id); });
  app.post('/api/deals/:id/settlement/challenge', async (req: any, reply) => {
    const s = await auth(req, reply);
    const c = await ps.settlementChallenge(ctx, s.uid, req.params.id);
    return { challengeId: c.challengeId, message: c.message, nonce: c.nonce, expiresAt: c.expiresAt };
  });
  app.post('/api/deals/:id/settlement/fund', { schema: { body: signed } }, async (req: any, reply) => { const s = await auth(req, reply); return ps.fundSettlement(ctx, s.uid, req.params.id, req.body); });
  app.post('/api/deals/:id/settlement/execute', async (req: any, reply) => { const s = await auth(req, reply); return ps.executeSettlement(ctx, s.uid, req.params.id); });

  // ---------------------------------------------------------------- auditoria (admin, todas as operações dele)
  app.get('/api/audit', async (req: any, reply) => {
    const s = await auth(req, reply);
    const { rows } = await db.query<any>(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.wallet, d.code FROM audit_logs a JOIN deals d ON d.id = a.deal_id
        WHERE d.admin_user_id = $1 ORDER BY a.id DESC LIMIT 300`, [s.uid]);
    return { events: rows.map((r) => ({ id: String(r.id), at: r.at, action: r.action, entity: r.entity, entityId: r.entity_id, wallet: r.wallet ? `${r.wallet.slice(0, 4)}...${r.wallet.slice(-4)}` : null, dealCode: r.code })) };
  });

  // Expiração automática periódica (além da varredura em cada acesso).
  const sweeper = setInterval(() => { ctx.db.tx((q) => inv.sweepInvitations(q, ctx)).catch(() => undefined); }, 30_000);
  sweeper.unref();
  app.addHook('onClose', async () => { clearInterval(sweeper); await db.close(); });

  return { app, ctx, db };
}

async function syncAssets(ctx: Ctx) {
  for (const a of ctx.assets.list()) {
    await ctx.db.query(
      `INSERT INTO assets (id, symbol, name, network, mint, decimals, status, verified, leg_type, environment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, network = EXCLUDED.network, mint = EXCLUDED.mint,
         decimals = EXCLUDED.decimals, status = EXCLUDED.status, verified = EXCLUDED.verified, leg_type = EXCLUDED.leg_type, environment = EXCLUDED.environment`,
      [a.id, a.symbol, a.name, a.network, a.mint, a.decimals, a.status, a.verified, a.legType, a.environment]);
  }
}
