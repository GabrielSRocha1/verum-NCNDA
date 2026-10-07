// Copia as bibliotecas embarcadas (sem CDN) do node_modules para public/vendor.
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/tweetnacl/nacl-fast.min.js', 'public/vendor/nacl-fast.min.js');
await copyFile('node_modules/tweetnacl/LICENSE', 'public/vendor/LICENSE-tweetnacl.txt');
await copyFile('node_modules/qrcode-generator/dist/qrcode.js', 'public/vendor/qrcode.js');
console.log('Bibliotecas embarcadas atualizadas em public/vendor (tweetnacl, qrcode-generator).');
// verum-connector.js NÃO está aqui de propósito: não vem do npm. É o conector da própria Verum,
// publicado pelo portal dela (ex.: https://swap.verumcrypto.com/swap-freeport-connector.js), e
// atualizar é baixar de novo e conferir com `node --test test/06-conector-verum.test.ts` —
// que simula a wallet-mãe e valida a assinatura. Copiar por cima sem rodar o teste é como trocar
// a fechadura sem testar a chave.
console.log('public/vendor/verum-connector.js vem do portal da Verum, não do npm — intocado aqui.');
