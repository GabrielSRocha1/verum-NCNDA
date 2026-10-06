// Prepara um banco COMPARTILHADO (DATABASE_URL — Supabase etc.): aplica as migrations e, em
// DEMO_MODE, semeia as mesas DEMO uma única vez. Rode isto uma vez por banco, antes do primeiro
// deploy. O processo que serve o app não semeia num banco compartilhado (ver src/app.ts): dois
// boots simultâneos criariam as mesas DEMO em duplicata.
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Este script é para banco de servidor; o banco local já se prepara sozinho no "npm start".');
  process.exit(1);
}

const { buildApp } = await import('../src/app.ts');
// seed: true usa o mesmo caminho de código do servidor (openDb aplica as migrations, seedDemo é
// idempotente e não faz nada se as mesas DEMO já existem).
const { app, ctx, db } = await buildApp({ seed: true, logger: false });

const { rows: migrations } = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
const { rows: [{ n: deals }] } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM deals WHERE is_demo");
const { rows: [{ n: users }] } = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');

console.log(`\nBanco pronto (${db.kind}).`);
console.log(`Migrations: ${migrations.map((m) => m.version).join(', ')}`);
console.log(`Mesas DEMO: ${deals} · usuários: ${users} · modo: ${ctx.cfg.demoMode ? 'DEMO — NO REAL FUNDS' : 'produção'}`);
console.log(`Origem pública configurada: ${ctx.cfg.publicOrigin}  (tem que ser igual à URL do deploy, senão o link do convite sai errado)\n`);

await app.close();
