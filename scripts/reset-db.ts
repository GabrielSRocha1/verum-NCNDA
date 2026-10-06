// Apaga o banco local (DATA_DIR) para recriar o DEMO do zero na próxima inicialização.
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const dir = process.env.DATA_DIR ?? './data/pgdata';
if (dir === 'memory') { console.log('DATA_DIR=memory: nada a apagar.'); process.exit(0); }
await rm(dir, { recursive: true, force: true });
console.log(`Banco removido: ${dir}. Rode "npm start" para recriar com os dados DEMO.`);
