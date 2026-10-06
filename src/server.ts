// Ponto de entrada: node src/server.ts  (Node >= 22.18 executa TypeScript nativamente)
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const { buildApp } = await import('./app.ts');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const { app, ctx } = await buildApp({ logger: true });
await app.listen({ port, host });
console.log(`\nVERUM NCNDA PRIVATE DAPP em ${ctx.cfg.publicOrigin}  ${ctx.cfg.demoMode ? '[DEMO — NO REAL FUNDS]' : ''}`);
console.log(`Rede: ${ctx.cfg.network} · Mainnet: DESLIGADA · Banco: ${ctx.cfg.dataDir ?? 'memória'}\n`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
