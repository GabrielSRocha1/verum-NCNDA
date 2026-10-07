import re, pathlib, html
root = pathlib.Path(__file__).resolve().parent.parent
pub = root / 'public'
def strip_module(src):
    src = re.sub(r"^import\s[^;]*?;\s*$", "", src, flags=re.M | re.S)
    src = re.sub(r"^import\s*\{[^}]*\}\s*from\s*'[^']+';", "", src, flags=re.M)
    src = re.sub(r"^export\s+(?=(async\s+)?function|const|let|class)", "", src, flags=re.M)
    return src
order = ['onboarding-logic.js', 'wallet-adapter.js', 'verum-provider.js', 'core.js', 'components.js', 'invite.js', 'app.js']
# Arquivo novo em public/js fora do order vira bundle sem a definição (a prévia só quebra ao abrir).
faltando = sorted(p.name for p in (pub / 'js').glob('*.js') if p.name not in order)
assert not faltando, f"arquivos em public/js fora do order: {', '.join(faltando)}"
parts = []
for f in order:
    s = strip_module((pub / 'js' / f).read_text())
    if f == 'app.js':
        s = s.replace("  const m = location.pathname.match(/^\\/i\\/([A-Za-z0-9_-]{43})\\/?$/);",
                      "  const m = location.hash.match(/^#\\/i\\/([A-Za-z0-9_-]{43})/);\n  if (m) window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/i/')) location.reload(); });")
        s = s.replace("  if (location.pathname.startsWith('/i/')) { startInvite(root, ''); return; }\n", "")
        s = s.replace("  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);\n", "")
        s = s.replace("return state.config?.demoMode ? h('div', { class: 'demo-ribbon' }, 'DEMO / TESTNET — NO REAL FUNDS') : null;",
                      "return h('div', { class: 'demo-ribbon' }, 'PRÉ-VISUALIZAÇÃO · DEMO / TESTNET — NO REAL FUNDS · ', h('button', { class: 'ribbon-reset', onclick: () => window.__votcPreviewReset() }, 'reiniciar demo'));")
        s = s.replace("async function render() {\n", "async function render() {\n  if (location.hash.startsWith('#/i/')) { location.reload(); return; }\n")
        assert "startsWith('#/i/')) { location.reload()" in s
        # doc.downloadUrl (data: URI do mock) sem substituição: o app já o prefere, pois sem servidor
        # não existe rota de conteúdo.
        assert 'location.hash.match' in s and 'ribbon-reset' in s and 'doc.downloadUrl ||' in s and 'serviceWorker' not in s
    if f == 'invite.js':
        s = s.replace("location.replace(`/#/deal/${r.dealId}`);", "location.hash = `#/deal/${r.dealId}`; location.reload();")
        assert 'location.reload()' in s
    parts.append(f"// ===== {f} =====\n{s}")
bundle = "\n".join(parts) + "\nwindow.addEventListener('error', (e) => console.error(e.message));\n"
css = (pub / 'app.css').read_text() + "\n.demo-ribbon{display:flex;justify-content:center;align-items:center;gap:8px}.ribbon-reset{background:none;border:1px solid #4A3B10;color:#F5C16C;font:inherit;padding:3px 8px;border-radius:999px;cursor:pointer;min-height:0}\n"
nacl = (pub / 'vendor' / 'nacl-fast.min.js').read_text()
qr = (pub / 'vendor' / 'qrcode.js').read_text()
mock = (root / 'preview' / 'mock-backend.js').read_text()
icon = (pub / 'icons' / 'icon.svg').read_text()
page = f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>VERUM NCNDA — Mesa privada (pré-visualização navegável)</title>
<meta name="theme-color" content="#0A0E1A">
<link rel="icon" href="data:image/svg+xml;utf8,{html.escape(icon, quote=True)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@400;600;700;800&display=swap">
<style>
{css}
html, body {{ background: #0A0E1A; }}
</style>
</head>
<body>
<div id="app"><noscript>Ative o JavaScript para usar a mesa privada.</noscript></div>
<div id="overlay"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>{nacl}</script>
<script>{qr}</script>
<script>{mock}</script>
<script type="module">
{bundle}
</script>
</body>
</html>
"""
out = pathlib.Path('/mnt/user-data/outputs/verum-ncnda-preview.html')
out.write_text(page)
(root / 'preview' / 'index.html').write_text(page)
print(out.stat().st_size // 1024, 'KB')
