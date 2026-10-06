// Banco de dados: Postgres de servidor (DATABASE_URL — Supabase, RDS, qualquer um) quando há
// estado compartilhado entre navegadores; PostgreSQL embarcado (PGlite, Postgres 18 em WASM) no
// desenvolvimento e nos testes. As migrations são SQL Postgres padrão — o mesmo schema nos dois.
import pg from 'pg';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDir } from './lib/paths.ts';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** SQL com vários comandos e sem parâmetros (arquivos de migration). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  kind: 'postgres' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Destino do banco: a URL ganha do diretório; dataDir null = PGlite em memória (testes). */
export interface DbTarget { databaseUrl?: string | null; dataDir?: string | null }

const MIGRATIONS_DIR = projectDir('migrations', import.meta.url);
// Chave do lock que serializa migrations concorrentes (dois processos subindo ao mesmo tempo).
const MIGRATION_LOCK = 0x5645_524d; // 'VERM'

// int8 como BigInt, igual ao PGlite. Sem isto o node-postgres devolveria string e os dois bancos
// divergiriam em COUNT(*) e no id bigserial de audit_logs — divergência que a suíte (que roda em
// PGlite) não pegaria. Com o parser alinhado, os 40 testes valem como prova dos dois caminhos.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string): any => BigInt(v));

export async function openDb(target: DbTarget | string | null): Promise<Db> {
  const t: DbTarget = typeof target === 'string' || target === null ? { dataDir: target } : target;
  const db = t.databaseUrl ? openPostgres(t.databaseUrl) : await openPglite(t.dataDir ?? null);
  try {
    await migrate(db);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  return db;
}

// ---------------------------------------------------------------- Postgres de servidor
/**
 * TLS: com DATABASE_CA (PEM do certificado do provedor) o servidor é autenticado de verdade.
 * Sem ela a conexão é cifrada mas não autenticada — é o padrão dos pools gerenciados, que usam
 * CA própria. DATABASE_SSL=disable só para Postgres local.
 */
function sslFor(connectionString: string): pg.ConnectionConfig['ssl'] {
  if ((process.env.DATABASE_SSL ?? '').toLowerCase() === 'disable') return false;
  let host = '';
  try { host = new URL(connectionString).hostname; } catch { /* URL opaca: mantém TLS */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  const ca = (process.env.DATABASE_CA ?? '').trim();
  return ca ? { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false };
}

function openPostgres(connectionString: string): Db {
  // max: 1 — o PGlite é conexão única, então a aplicação já foi escrita sem depender de
  // paralelismo de conexões, e uma conexão por instância é o que um pooler (pgbouncer/Supavisor)
  // espera. Transações seguram essa conexão; o resto das consultas enfileira, como no PGlite.
  const pool = new pg.Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    application_name: 'verum-ncnda',
  });
  // Sem este handler, um erro de conexão ociosa derruba o processo inteiro.
  pool.on('error', () => undefined);
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query(sql, params = []) {
      const r = await c.query(sql, params as any[]);
      return { rows: (r.rows ?? []) as any[] };
    },
    async exec(sql) { await c.query(sql); },
  });
  const base = wrap(pool);
  return {
    kind: 'postgres',
    query: base.query,
    exec: base.exec,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

// ---------------------------------------------------------------- PGlite (dev e testes)
async function openPglite(dataDir: string | null): Promise<Db> {
  // Import dinâmico: o PGlite é um Postgres em WASM de dezenas de MB. Num deploy serverless com
  // DATABASE_URL ele nunca é usado, e carregá-lo no topo custaria esse tempo em cada cold start.
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pgl = dataDir ? new PGlite(dataDir) : new PGlite();
  await pgl.waitReady;
  // Serializa transações: PGlite é uma conexão única.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    kind: 'pglite',
    query(sql, params = []) {
      return serialize(() => pgl.query(sql, params as any[]).then((r) => ({ rows: r.rows as any[] }))) as any;
    },
    exec(sql) {
      return serialize(() => pgl.exec(sql).then(() => undefined));
    },
    tx(fn) {
      return serialize(() => pgl.transaction(async (t) => fn({
        async query(sql, params = []) {
          const r = await t.query(sql, params as any[]);
          return { rows: r.rows as any[] };
        },
        async exec(sql) { await t.exec(sql); },
      })) as Promise<any>);
    },
    async close() { await pgl.close(); },
  };
}

// ---------------------------------------------------------------- migrations
/**
 * Aplica os arquivos de migrations pendentes, cada um numa transação. No Postgres de servidor um
 * lock de transação serializa processos concorrentes (vários boots ao mesmo tempo): quem perde a
 * corrida encontra a versão já registrada e não reaplica nada.
 */
export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    const ran = await db.tx(async (q) => {
      if (db.kind === 'postgres') await q.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      await q.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await q.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [f]);
      if (rows.length) return false;
      try {
        await q.exec(sql);
      } catch (e) {
        throw new Error(`Falha na migration ${f}: ${(e as Error).message}`);
      }
      await q.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [f]);
      return true;
    });
    if (ran) applied.push(f);
  }
  return applied;
}

/** Extrai o código de erro de negócio lançado por triggers (ex.: 'LOCKED_VERSION'). */
export function dbErrorCode(e: unknown): string | null {
  const msg = (e as Error)?.message ?? '';
  const m = msg.match(/^([A-Z_]{4,})(?::|$)/);
  return m ? m[1] : null;
}
