// Copia as bibliotecas embarcadas (sem CDN) do node_modules para public/vendor.
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/tweetnacl/nacl-fast.min.js', 'public/vendor/nacl-fast.min.js');
await copyFile('node_modules/tweetnacl/LICENSE', 'public/vendor/LICENSE-tweetnacl.txt');
await copyFile('node_modules/qrcode-generator/dist/qrcode.js', 'public/vendor/qrcode.js');
console.log('Bibliotecas embarcadas atualizadas em public/vendor (tweetnacl, qrcode-generator).');
