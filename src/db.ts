// Banco de dados: PostgreSQL embarcado (PGlite, Postgres 18 em WASM) com persistência em disco.
// As migrations são SQL Postgres padrão — o mesmo schema roda em um Postgres de servidor.
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  raw: PGlite;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function openDb(dataDir: string | null): Promise<Db> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // Serializa transações: PGlite é uma conexão única.
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    raw: pg,
    query(sql, params = []) {
      const run = chain.then(() => pg.query(sql, params as any[]).then((r) => ({ rows: r.rows as any[] })));
      chain = run.catch(() => undefined);
      return run as any;
    },
    tx(fn) {
      const run = chain.then(() => pg.transaction(async (t) => fn({
        async query(sql, params = []) {
          const r = await t.query(sql, params as any[]);
          return { rows: r.rows as any[] };
        },
      })));
      chain = run.catch(() => undefined);
      return run as any;
    },
    async close() { await pg.close(); },
  };
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await db.raw.exec('BEGIN');
    try {
      await db.raw.exec(sql);
      await db.raw.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      await db.raw.exec('COMMIT');
    } catch (e) {
      await db.raw.exec('ROLLBACK');
      throw new Error(`Falha na migration ${f}: ${(e as Error).message}`);
    }
    applied.push(f);
  }
  return applied;
}

/** Extrai o código de erro de negócio lançado por triggers (ex.: 'LOCKED_VERSION'). */
export function dbErrorCode(e: unknown): string | null {
  const msg = (e as Error)?.message ?? '';
  const m = msg.match(/^([A-Z_]{4,})(?::|$)/);
  return m ? m[1] : null;
}
