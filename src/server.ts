// Ponto de entrada: node src/server.ts  (Node >= 22.18 executa TypeScript nativamente)
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const { buildApp } = await import('./app.ts');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const { app, ctx, db } = await buildApp({ logger: true });
await app.listen({ port, host });
// Banco: descreve o que está em uso de fato, sem vazar usuário e senha da URL no log.
const banco = ctx.cfg.databaseUrl
  ? `Postgres de servidor (${(() => { try { return new URL(ctx.cfg.databaseUrl).host; } catch { return 'url opaca'; } })()})`
  : `PGlite ${ctx.cfg.dataDir ?? 'em memória'}`;
console.log(`\nVERUM NCNDA PRIVATE DAPP em ${ctx.cfg.publicOrigin}  ${ctx.cfg.demoMode ? '[DEMO — NO REAL FUNDS]' : ''}`);
console.log(`Rede: ${ctx.cfg.network} · Mainnet: DESLIGADA · Banco: ${banco} [${db.kind}] · Escutando: ${host}:${port}\n`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
