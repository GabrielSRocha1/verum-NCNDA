// Gera preview/index.html — a pré-visualização navegável, um único arquivo que roda sem
// servidor e sem node_modules. Porta em Node do build.py, para quem não tem Python instalado.
// Os dois devem produzir o mesmo arquivo: mesma ordem, mesmas substituições, mesmos asserts.
//
//   node preview/build.mjs                      -> escreve preview/index.html
//   node preview/build.mjs --out caminho.html   -> escreve também numa cópia avulsa
//   node preview/build.mjs --check              -> não escreve; falha se index.html estiver desatualizado
//
// Fontes: public/js/*.js (na ordem abaixo), public/app.css, public/vendor/*,
// public/icons/icon.svg e preview/mock-backend.js. Editar o index.html à mão não serve:
// a mudança some no próximo build. Mexa nas fontes e rode isto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pub = path.join(root, 'public');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const outFlag = args.indexOf('--out');
const extraOut = outFlag >= 0 ? args[outFlag + 1] : null;

const fail = (msg) => { console.error(`build.mjs: ${msg}`); process.exit(1); };
const must = (cond, msg) => { if (!cond) fail(`asserção falhou — ${msg}. O app.js mudou e o build não acompanhou.`); };

// Remove a sintaxe de módulo: o bundle é um único <script type="module">.
// Mesma ordem do build.py (import multilinha, import com chaves, depois export).
const stripModule = (src) => src
  .replace(/^import\s[^;]*?;\s*$/gm, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'[^']+';/gm, '')
  .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '');

const ORDER = ['onboarding-logic.js', 'wallet-adapter.js', 'core.js', 'components.js', 'invite.js', 'app.js'];
const parts = [];

for (const f of ORDER) {
  let s = stripModule(read(pub, 'js', f));

  if (f === 'app.js') {
    // Na prévia o convite vive no hash (#/i/:token), não no pathname: não há servidor para rotear.
    s = s.replace(
      "  const m = location.pathname.match(/^\\/i\\/([A-Za-z0-9_-]{43})\\/?$/);",
      "  const m = location.hash.match(/^#\\/i\\/([A-Za-z0-9_-]{43})/);\n  if (m) window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/i/')) location.reload(); });");
    s = s.replace("  if (location.pathname.startsWith('/i/')) { startInvite(root, ''); return; }\n", '');
    // Sem service worker: arquivo único, possivelmente aberto via file://.
    s = s.replace("  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);\n", '');
    // Faixa da prévia com o botão de reiniciar o DEMO.
    s = s.replace(
      "return state.config?.demoMode ? h('div', { class: 'demo-ribbon' }, 'DEMO / TESTNET — NO REAL FUNDS') : null;",
      "return h('div', { class: 'demo-ribbon' }, 'PRÉ-VISUALIZAÇÃO · DEMO / TESTNET — NO REAL FUNDS · ', h('button', { class: 'ribbon-reset', onclick: () => window.__votcPreviewReset() }, 'reiniciar demo'));");
    // Download de documento vira data: URI — não existe rota de conteúdo sem servidor.
    s = s.replace(
      "h('a', { class: 'btn btn-ghost btn-sm', href: `/api/deals/${d.id}/documents/${doc.versionId}/content` }, 'BAIXAR')",
      "h('a', { class: 'btn btn-ghost btn-sm', href: doc.downloadUrl, download: doc.name }, 'BAIXAR')");
    s = s.replace('async function render() {\n', "async function render() {\n  if (location.hash.startsWith('#/i/')) { location.reload(); return; }\n");

    must(s.includes("startsWith('#/i/')) { location.reload()"), 'recarga do convite em render()');
    must(s.includes('location.hash.match'), 'roteamento do convite por hash');
    must(s.includes('ribbon-reset'), 'faixa da prévia');
    must(s.includes('doc.downloadUrl'), 'download por data: URI');
    must(!s.includes('serviceWorker'), 'service worker removido');
  }

  if (f === 'invite.js') {
    s = s.replace('location.replace(`/#/deal/${r.dealId}`);', 'location.hash = `#/deal/${r.dealId}`; location.reload();');
    must(s.includes('location.reload()'), 'recarga ao concluir o convite');
  }

  parts.push(`// ===== ${f} =====\n${s}`);
}

const bundle = parts.join('\n') + "\nwindow.addEventListener('error', (e) => console.error(e.message));\n";
const css = read(pub, 'app.css')
  + '\n.demo-ribbon{display:flex;justify-content:center;align-items:center;gap:8px}'
  + '.ribbon-reset{background:none;border:1px solid #4A3B10;color:#F5C16C;font:inherit;padding:3px 8px;border-radius:999px;cursor:pointer;min-height:0}\n';
const nacl = read(pub, 'vendor', 'nacl-fast.min.js');
const qr = read(pub, 'vendor', 'qrcode.js');
const mock = read(root, 'preview', 'mock-backend.js');
const icon = read(pub, 'icons', 'icon.svg');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const page = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>VERUM NCNDA — Mesa privada (pré-visualização navegável)</title>
<meta name="theme-color" content="#0A0E1A">
<link rel="icon" href="data:image/svg+xml;utf8,${esc(icon)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@400;600;700;800&display=swap">
<style>
${css}
html, body { background: #0A0E1A; }
</style>
</head>
<body>
<div id="app"><noscript>Ative o JavaScript para usar a mesa privada.</noscript></div>
<div id="overlay"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>${nacl}</script>
<script>${qr}</script>
<script>${mock}</script>
<script type="module">
${bundle}
</script>
</body>
</html>
`;

const target = path.join(root, 'preview', 'index.html');
const kb = Math.floor(Buffer.byteLength(page) / 1024);

if (checkOnly) {
  const atual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (atual === page) { console.log(`preview/index.html está em dia (${kb} KB).`); process.exit(0); }
  fail('preview/index.html está desatualizado em relação às fontes. Rode "npm run preview".');
}

fs.writeFileSync(target, page);
console.log(`${kb} KB escritos em preview/index.html`);
if (extraOut) { fs.writeFileSync(extraOut, page); console.log(`cópia em ${extraOut}`); }
