// Configuração central. Lida do ambiente (.env) com valores padrão seguros.
import { randomBytes } from 'node:crypto';

export interface RateLimitRule { max: number; windowMs: number }

export interface SmtpConfig {
  host: string; port: number; user: string; pass: string;
  from: string;                  // remetente exibido
  operador: string | null;       // quem recebe o aviso de nova solicitação
}

export interface AppConfig {
  demoMode: boolean;
  network: 'solana-demo' | 'solana-devnet';
  mainnetEnabled: false;
  publicOrigin: string;          // ex.: http://localhost:8787 — usado no link do convite e no challenge
  databaseUrl: string | null;    // Postgres de servidor (Supabase etc.); ganha do dataDir
  dataDir: string | null;        // PGlite: diretório de dados; null = em memória (testes)
  sessionSecret: Buffer;         // HMAC de sessão/cookies
  invitePepper: Buffer;          // HMAC do código VOTC
  cookieSecure: boolean;
  inviteTtlHours: number;
  resumeWindowMinutes: number;   // 0 = uso único estrito
  onboardingTtlMinutes: number;  // prazo para concluir o cadastro após abrir
  challengeTtlSeconds: number;
  sessionTtlMinutes: number;
  sessionMaxHours: number;
  verumWalletDownloadUrl: string;
  accessRequests: boolean;       // formulário público de solicitação de acesso ligado?
  smtp: SmtpConfig | null;       // null = envio de e-mail desligado (sem senha configurada)
  rateLimits: Record<'open' | 'resume' | 'verifyCode' | 'walletChallenge' | 'walletVerify' | 'authChallenge' | 'authVerify', RateLimitRule>;
  now: () => Date;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function int(v: string | undefined, d: number, min: number, max: number): number {
  if (v === undefined || v === '') return d;
  if (!/^\d+$/.test(v)) throw new Error(`Valor inteiro inválido: ${v}`);
  const n = Number(v);
  if (n < min || n > max) throw new Error(`Valor fora do intervalo [${min}, ${max}]: ${v}`);
  return n;
}
/**
 * E-mail é opcional: sem SMTP_PASS o envio fica desligado e a interface deixa de prometer retorno
 * por e-mail. Melhor não prometer do que prometer e não entregar.
 */
function smtpFrom(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const pass = (env.SMTP_PASS ?? '').trim();
  if (!pass) return null;
  const user = (env.SMTP_USER ?? '').trim();
  if (!user) throw new Error('SMTP_USER é obrigatório quando SMTP_PASS está definida.');
  const port = int(env.SMTP_PORT, 465, 1, 65535);
  const host = (env.SMTP_HOST ?? 'smtp.zoho.com').trim();
  const from = (env.MAIL_FROM ?? '').trim() || `VERUM NCNDA <${user}>`;
  const operador = (env.MAIL_OPERADOR ?? '').trim() || user;
  return { host, port, user, pass, from, operador };
}

/**
 * Segredos de HMAC. Só podem ser efêmeros (sorteados a cada boot) quando o banco também é local:
 * num banco compartilhado, pepper novo invalida o código dos convites JÁ ENVIADOS e segredo novo
 * derruba todas as sessões a cada reinício — o parceiro receberia "convite não é mais válido".
 */
function secret(v: string | undefined, name: string, ephemeralOk: boolean, why: string): Buffer {
  if (v && v.length >= 32) return Buffer.from(v, 'utf8');
  if (!ephemeralOk) throw new Error(`${name} obrigatório (mínimo 32 caracteres) ${why}`);
  return randomBytes(32);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const demoMode = bool(env.DEMO_MODE, true);
  const network = (env.SOLANA_NETWORK ?? 'solana-demo') as AppConfig['network'];
  if (!['solana-demo', 'solana-devnet'].includes(network)) {
    throw new Error('SOLANA_NETWORK aceita apenas solana-demo ou solana-devnet. Mainnet está desligada.');
  }
  if (bool(env.MAINNET_ENABLED, false)) {
    throw new Error('MAINNET_ENABLED=true recusado: mainnet exige revisão de segurança e autorização explícita.');
  }
  const databaseUrl = (env.DATABASE_URL ?? '').trim() || null;
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('DATABASE_URL deve ser uma URL postgres:// ou postgresql://');
  }
  // Banco compartilhado = deploy com gente de fora abrindo links: segredo efêmero não serve.
  const ephemeralSecretsOk = demoMode && !databaseUrl;
  const why = databaseUrl
    ? 'quando o banco é compartilhado (DATABASE_URL), senão cada reinício invalida os convites já enviados'
    : 'fora do DEMO_MODE';
  const cfg: AppConfig = {
    demoMode,
    network,
    mainnetEnabled: false,
    publicOrigin: (env.PUBLIC_ORIGIN ?? 'http://localhost:8787').replace(/\/$/, ''),
    databaseUrl,
    dataDir: env.DATA_DIR === 'memory' ? null : (env.DATA_DIR ?? './data/pgdata'),
    sessionSecret: secret(env.SESSION_SECRET, 'SESSION_SECRET', ephemeralSecretsOk, why),
    invitePepper: secret(env.INVITE_PEPPER, 'INVITE_PEPPER', ephemeralSecretsOk, why),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    inviteTtlHours: int(env.INVITE_TTL_HOURS, 24, 1, 720),
    resumeWindowMinutes: int(env.RESUME_WINDOW_MINUTES, 10, 0, 120),
    onboardingTtlMinutes: int(env.ONBOARDING_TTL_MINUTES, 10, 1, 240),
    challengeTtlSeconds: 120,
    sessionTtlMinutes: int(env.SESSION_TTL_MINUTES, 15, 5, 120),
    sessionMaxHours: int(env.SESSION_MAX_HOURS, 12, 1, 72),
    verumWalletDownloadUrl: (env.VERUM_WALLET_DOWNLOAD_URL ?? '').trim(),
    // Desligado por padrão: é a única porta de entrada sem convite, e só deve existir enquanto
    // você estiver de fato recebendo solicitações.
    accessRequests: bool(env.ACCESS_REQUESTS, false),
    smtp: smtpFrom(env),
    rateLimits: {
      open: { max: 10, windowMs: 60_000 },
      resume: { max: 20, windowMs: 60_000 },
      verifyCode: { max: 10, windowMs: 60_000 },
      walletChallenge: { max: 20, windowMs: 60_000 },
      walletVerify: { max: 10, windowMs: 60_000 },
      authChallenge: { max: 20, windowMs: 60_000 },
      authVerify: { max: 10, windowMs: 60_000 },
    },
    now: () => new Date(),
    ...overrides,
  };
  if (cfg.verumWalletDownloadUrl && !/^https:\/\//.test(cfg.verumWalletDownloadUrl)) {
    throw new Error('VERUM_WALLET_DOWNLOAD_URL deve começar com https://');
  }
  return cfg;
}

/** Prazo final de um convite ABERTO: fim da janela de retomada ou do prazo de cadastro, o que for maior, limitado à validade. */
export function openDeadline(cfg: AppConfig, openedAt: Date, expiresAt: Date): Date {
  const minutes = Math.max(cfg.resumeWindowMinutes, cfg.onboardingTtlMinutes);
  const d = new Date(openedAt.getTime() + minutes * 60_000);
  return d < expiresAt ? d : expiresAt;
}
