// Núcleo do cliente: DOM seguro (sem innerHTML com dados), API, toast, sheet, ícones, carteira DEMO.
import { createWalletAdapter } from './wallet-adapter.js';
import { detectVerumProviders, mensagensVistas } from './verum-provider.js';

export const state = { config: null, me: null, personas: [], adapter: null, scroll: {} };

// ---------------------------------------------------------------- DOM
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = String(v); // CSSOM: permitido pela CSP (sem 'unsafe-inline')
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
/** Anexa filhos com segurança: achata listas e ignora null/undefined/false (o append nativo não faz isso). */
export const add = (el, ...kids) => append(el, kids);
export const clear = (el) => { el.replaceChildren(); return el; }; // atômico: seguro mesmo durante blur/change

const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  deals: 'M4 6h16M4 12h16M4 18h10',
  partner: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15.5c.6-.3 1.3-.5 2-.5 3 0 6 2 6 5',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zm14 7h.01',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  invite: 'M4 6h16v12H4zM4 7l8 6 8-6',
  people: 'M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5M17 8h5M17 13h5M17 18h5',
  docs: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  settle: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zm14 0l-3 7a3 3 0 0 0 6 0z',
  audit: 'M9 4h6v3H9zM6 5H5v16h14V5h-1M9 12h6M9 16h4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z',
  back: 'M15 5l-7 7 7 7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  plus: 'M12 5v14M5 12h14',
};
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] ?? ''); s.append(p);
  return s;
}
export function brandMark() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M4 5h4l4 10 4-10h4l-6.5 15h-3z'); p.setAttribute('fill', '#fff'); s.append(p);
  return h('span', { class: 'brand-mark' }, s);
}
export function brand(sub = 'Mesa OTC privada') {
  return h('div', { class: 'brand' }, brandMark(), h('div', {}, 'VERUM NCNDA', h('small', {}, sub)));
}

/** QR gerado localmente (biblioteca embarcada), desenhado como SVG via DOM. */
export function qrSvg(text) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  const m = 2;
  s.setAttribute('viewBox', `0 0 ${n + m * 2} ${n + m * 2}`); s.setAttribute('shape-rendering', 'crispEdges');
  s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'QR Code do endereço');
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const bg = document.createElementNS(ns, 'rect'); bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#0A0E1A');
  s.append(bg, p);
  return s;
}

// ---------------------------------------------------------------- API
export async function api(method, url, body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) {
    const e = new Error(data.message || 'Falha na comunicação com a mesa.');
    e.status = r.status; e.code = data.error; e.data = data;
    throw e;
  }
  return data;
}

let toastTimer = null;
export function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  clear(el);
  el.append(h('div', { class: `toast ${kind === 'err' ? 'err' : ''}` }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(el), 4200);
}
export async function copy(text, label = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(label); } catch { toast('Não foi possível copiar. Selecione e copie manualmente.', 'err'); }
    ta.remove();
  }
}

// ---------------------------------------------------------------- Bottom sheet
let sheetReturnFocus = null;
export function openSheet(build, { label = 'Detalhes', onClose } = {}) {
  const overlay = document.getElementById('overlay');
  clear(overlay);
  sheetReturnFocus = document.activeElement;
  const close = () => { clear(overlay); document.removeEventListener('keydown', onKey); onClose?.(); sheetReturnFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const sheet = h('div', { class: 'sheet entering', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  const handle = h('button', { class: 'sheet-handle', 'aria-label': 'Expandir ou recolher', onclick: () => sheet.classList.toggle('expanded') });
  sheet.append(handle);
  const body = h('div', {});
  sheet.append(body);
  overlay.append(h('div', { class: 'scrim', onclick: close }), sheet);
  requestAnimationFrame(() => sheet.classList.remove('entering'));
  const api = { close, body, sheet, render: (...kids) => { clear(body); append(body, kids); } };
  build(api);
  // Foco no primeiro controle sem rolar: o QR (topo do sheet) precisa ficar visível.
  setTimeout(() => { (sheet.querySelector('button:not(.sheet-handle), input, a') || handle).focus({ preventScroll: true }); sheet.scrollTop = 0; }, 30);
  return api;
}

// ---------------------------------------------------------------- Verum Wallet
// A carteira real (extensão) e a DEMO convivem: `providers` guarda as duas, `provider` é a ativa.
// Tudo que fala com provider é AGUARDADO — a carteira real pede confirmação ao usuário e devolve
// Promise, enquanto a DEMO responde na hora; esperar funciona para as duas.
export function getAdapter() {
  if (!state.adapter) {
    const { providers, sonda } = detectVerumProviders();
    state.adapter = createWalletAdapter({
      demoMode: !!state.config?.demoMode,
      simulateMissing: sessionStorage.getItem('votc-sim-no-wallet') === '1',
      personas: state.personas,
      storage: localStorage,
      injected: providers,
      probe: sonda,
    });
  }
  return state.adapter;
}
export function resetAdapter() { state.adapter = null; }

/** Contas de TODAS as carteiras aceitas, cada uma sabendo de onde veio. */
async function listarContas(ad, only) {
  const out = [];
  for (const p of ad.providers) {
    // Carteira que declarou não assinar mensagem não serve para a mesa: listá-la seria oferecer uma
    // escolha que termina em erro, e só para listar seria preciso CONECTAR nela — um pedido de
    // confirmação na carteira por uma conta que não pode ser usada.
    if (!podeAssinarMensagem(p)) continue;
    let accs = [];
    try { accs = await p.accounts(); } catch { accs = []; }   // extensão trancada ou recusada: segue sem ela
    for (const a of accs) {
      if (only && !only.includes(a.key)) continue;
      out.push({ ...a, provider: p, origem: p.demo ? 'DEMO' : (p.label ?? 'Verum Wallet') });
    }
  }
  return out;
}

/** Seletor de conta. Mostra a carteira real e as personas DEMO juntas, cada uma etiquetada. */
export async function walletPick({ title = 'Conectar Verum Wallet', allowCreate = true, only = null } = {}) {
  const ad = getAdapter();
  if (!ad.isAvailable()) throw Object.assign(new Error(ad.reason || 'Verum Wallet não encontrada neste aparelho.'), { code: 'NO_WALLET' });
  let contas = await listarContas(ad, only);
  const demo = ad.providers.find((p) => p.demo);
  return new Promise((resolve, reject) => {
    let done = false;
    openSheet((s) => {
      const draw = () => s.render(
        h('h2', {}, title),
        h('p', { class: 'muted small' }, 'As chaves ficam na carteira; a mesa nunca pede seed, chave privada ou senha.'),
        h('div', { style: 'margin:14px 0' },
          contas.length ? contas.map((a) => h('button', {
            class: 'wallet-acc',
            onclick: () => { done = true; ad.use(a.provider); s.close(); resolve(a); },
          },
          h('div', {}, h('b', {}, a.name), h('div', { class: 'small muted' }, a.hint || a.origem)),
          h('span', { class: 'mono small' }, `${a.address.slice(0, 4)}...${a.address.slice(-4)}`)))
            : h('p', { class: 'muted small' }, 'Nenhuma conta disponível nesta carteira.')),
        allowCreate && demo ? h('button', {
          class: 'btn btn-ghost btn-block',
          onclick: async () => { await demo.createGuest(); contas = await listarContas(ad, only); draw(); },
        }, icon('plus'), 'Criar nova carteira (DEMO)') : null,
        demo ? h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Personas DEMO usam chaves derivadas de sementes públicas. NO REAL FUNDS.') : null,
      );
      draw();
    }, { label: title, onClose: () => { if (!done) reject(Object.assign(new Error('Conexão cancelada.'), { code: 'CANCELLED' })); } });
  });
}

/**
 * Conectar "a Verum Wallet", e não "uma conta": se a carteira real está nesta página, vai direto
 * nela — quem tem a carteira não deveria ver uma lista de personas simuladas. O seletor aparece
 * quando a única coisa disponível é a DEMO, ou quando a real declarou que não assina mensagem.
 */
export async function connectVerum({ title = 'Conectar Verum Wallet', forcarReal = false } = {}) {
  const ad = getAdapter();
  const reais = ad.providers.filter((p) => !p.demo);
  const real = reais.find(podeAssinarMensagem) ?? reais[0];
  const demo = ad.providers.find((p) => p.demo);
  // Carteira real que DECLAROU não assinar mensagem não serve para a mesa. Havendo DEMO, o seletor
  // é melhor que o beco sem saída: a pessoa vê as duas, etiquetadas, e escolhe sabendo qual é qual.
  // forcarReal = alguém pediu explicitamente para tentar a carteira real apesar da declaração; é o
  // caminho de quem está conferindo se a carteira passou a assinar sem anunciar.
  if (!real || (!forcarReal && !podeAssinarMensagem(real) && demo)) return walletPick({ title });
  ad.use(real);
  const conta = await real.connect();
  return { ...conta, provider: real, origem: real.label ?? 'Verum Wallet' };
}

/**
 * Deixa a conta escolhida ativa. Conectar de novo numa conta JÁ conectada é pedir a confirmação
 * duas vezes na carteira real — a primeira veio do connectVerum. Escolher conta por chave é
 * conceito do provider DEMO (ele guarda várias personas); a carteira real conecta a conta ativa
 * dela e ignora o argumento.
 */
export async function usarConta(acc) {
  const ad = getAdapter();
  ad.use(acc.provider ?? ad.provider);
  if (ad.provider.current?.key === acc.key) return acc;
  await ad.provider.connect(acc.key);
  return acc;
}

/** A carteira real (não DEMO) presente nesta página, se houver. */
export function carteiraReal() {
  return getAdapter().providers.find((p) => !p.demo) ?? null;
}

/** Há carteira real neste navegador? */
export function temCarteiraReal() {
  return !!carteiraReal();
}

/**
 * Carteira real que SERVE para a mesa: existe E assina mensagem. A distinção não é preciosismo —
 * dentro do app da Verum existe carteira real que não assina, e prometer "entrar com a Verum
 * Wallet" ali é prometer o que não acontece.
 */
export function temCarteiraUtilizavel() {
  const real = carteiraReal();
  return !!real && podeAssinarMensagem(real);
}

/**
 * A carteira sabe assinar mensagem? Lista vazia = não declarou nada, e aí tentar é o certo (carteira
 * antiga). Lista cheia sem 'signMessage' = ela avisou que não faz isso, e a mesa não entra sem
 * assinatura — insistir renderia dois minutos de espera por uma resposta que não vem.
 */
export function podeAssinarMensagem(provider) {
  const caps = provider?.capacidades ?? [];
  return !caps.length || caps.includes('signMessage');
}

/**
 * Traduz a falha crua do conector. Isto estava inline e tratava TUDO como cancelamento — e quem
 * chama ignora cancelamento em silêncio, então a carteira ficar muda não mostrava NADA na tela.
 * Recusar é cancelar; ficar sem resposta não é.
 */
export function falhaDeAssinatura(erro) {
  const bruto = (erro && erro.message) || String(erro);
  if (/REJECT/i.test(bruto)) return { code: 'CANCELLED', message: 'Assinatura recusada na carteira.' };
  if (/TIMEOUT/i.test(bruto)) return { code: 'WALLET_TIMEOUT', message: 'A Verum Wallet não respondeu ao pedido de assinatura. Verifique se o aplicativo está aberto e tente de novo.' };
  return { code: 'WALLET_ERROR', message: bruto };
}

/**
 * Pedido de assinatura de MENSAGEM.
 * - DEMO: a mesa desenha a janela que a carteira desenharia.
 * - Carteira real: a carteira desenha a dela. Aqui só mostramos a mensagem e esperamos — desenhar
 *   um botão ASSINAR nosso na frente do pedido real seria um pedido falso em cima do verdadeiro.
 */
export function walletSign(message, { title = 'Assinar mensagem', action = 'ASSINAR' } = {}) {
  const ad = getAdapter();
  const p = ad.provider;
  if (!p) return Promise.reject(new Error('Verum Wallet indisponível.'));
  const curta = (c) => (c ? `${c.address.slice(0, 4)}...${c.address.slice(-4)}` : '');
  return new Promise((resolve, reject) => {
    let done = false;
    let demora = null;      // avisa quando a carteira some; precisa morrer junto com o sheet
    openSheet((s) => {
      if (p.demo) {
        s.render(
          h('h2', {}, title),
          h('p', { class: 'muted small', style: 'margin-bottom:10px' }, `Verum Wallet (DEMO) · ${curta(p.current)}`),
          h('div', { class: 'sigmsg' }, message),
          h('div', { class: 'btn-row', style: 'margin-top:14px' },
            h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, 'RECUSAR'),
            h('button', {
              class: 'btn btn-primary',
              onclick: async () => { done = true; const sig = await p.signMessage(message); s.close(); resolve(sig); },
            }, action)),
        );
        return;
      }
      const estado = h('p', { class: 'notice notice-info', style: 'margin-top:14px' }, 'Confirme na Verum Wallet para continuar.');
      const cabecalho = () => [
        h('h2', {}, title),
        h('p', { class: 'muted small', style: 'margin-bottom:10px' }, `${p.label ?? 'Verum Wallet'} · ${curta(p.current)}`),
        h('div', { class: 'sigmsg' }, message),
      ];

      const pedir = () => {
        s.render(...cabecalho(), estado,
          // Sem isto a única saída de uma carteira que não responde é fechar a página: o sheet fica
          // parado em "confirme na carteira" até o prazo do conector (dois minutos).
          h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:12px', onclick: () => s.close() }, 'CANCELAR'));

        // Nenhuma janela apareceu na carteira? Depois de alguns segundos isso deixa de ser demora e
        // passa a ser sinal de que o pedido não foi atendido. Avisar é melhor que girar em silêncio.
        demora = setTimeout(() => {
          estado.className = 'notice notice-risk';
          clear(estado);
          // "Não respondeu" sozinho não resolve nada: se a pessoa JÁ assinou, o que importa é o que
          // a carteira mandou de volta e por que não foi aceito. Isto vira print e vira correção.
          const vistas = mensagensVistas();
          const depoisDoPedido = vistas.filter((m) => /SIGN_MSG|SIGN_MESSAGE/i.test(m.tipo));
          add(estado,
            h('b', {}, 'A carteira ainda não respondeu a este pedido.'),
            h('p', { style: 'margin-top:6px' }, depoisDoPedido.length
              ? 'Ela mandou uma resposta de assinatura que o conector não aceitou — veja abaixo o que chegou.'
              : 'Se você já assinou na Verum Wallet, a resposta não chegou até aqui. O que a carteira mandou:'),
            h('div', { class: 'hash', style: 'margin-top:8px;white-space:pre-wrap' }, vistas.length
              ? vistas.map((m) => `${m.tipo}  ←  ${m.origem}\n   campos: ${m.chaves.join(', ') || '(nenhum)'}`).join('\n')
              : 'nenhuma mensagem do protocolo VERUM_ chegou nesta página.'));
        }, 12000);

        p.signMessage(message).then((sig) => { clearTimeout(demora); done = true; s.close(); resolve(sig); })
          .catch((e) => {
            clearTimeout(demora); done = true; s.close();
            const f = falhaDeAssinatura(e);
            reject(Object.assign(new Error(f.message), { code: f.code }));
          });
      };

      // A carteira declara no handshake o que sabe fazer. Declarou e não listou assinatura de
      // mensagem? Dizer agora poupa o prazo inteiro de espera. Mas a trava é pelo que ela DECLARA,
      // e declaração pode estar desatualizada — daí a porta de saída, em vez de um "não" definitivo
      // que esconderia uma carteira que passou a assinar sem anunciar.
      if (!podeAssinarMensagem(p)) {
        s.render(...cabecalho(),
          h('div', { class: 'notice notice-risk', style: 'margin-top:14px' },
            'Esta carteira não declarou saber assinar mensagem. A mesa entra só por assinatura — é assim que ela prova que a carteira é sua, sem senha.'),
          h('p', { class: 'small muted', style: 'margin-top:8px' }, `A carteira declara: ${(p.capacidades ?? []).join(' · ') || '—'}`),
          h('div', { class: 'btn-row', style: 'margin-top:14px' },
            h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, 'CANCELAR'),
            h('button', { class: 'btn btn-primary', onclick: () => pedir() }, 'TENTAR MESMO ASSIM')));
        return;
      }

      pedir();
    }, { label: title, onClose: () => { clearTimeout(demora); if (!done) reject(Object.assign(new Error('Assinatura recusada.'), { code: 'CANCELLED' })); } });
  });
}

/**
 * Com qual carteira a pessoa entra. Separado do login de propósito: é a regra que já regrediu uma
 * vez (o botão de entrar abria a lista de personas DEMO com a carteira real disponível) e aqui ela
 * é verificável sem navegador. Com a carteira real na mão, entrar é "entrar com a Verum Wallet" e
 * ponto — o seletor é o caminho de quem só tem a DEMO.
 */
export async function escolherContaParaEntrar(accountKey = null, { forcarReal = false } = {}) {
  const ad = getAdapter();
  const acc = accountKey
    ? (await listarContas(ad, [accountKey]))[0]
    : await connectVerum({ title: 'Entrar com a Verum Wallet', forcarReal });
  if (!acc) throw Object.assign(new Error('Conta não encontrada na carteira.'), { code: 'NO_WALLET' });
  await usarConta(acc);
  return acc;
}

/** Login sem senha: challenge → assinatura → sessão curta. */
export async function walletLogin(accountKey = null, opcoes = {}) {
  const acc = await escolherContaParaEntrar(accountKey, opcoes);
  const ch = await api('POST', '/auth/wallet-challenge', { address: acc.address });
  const signature = await walletSign(ch.message, { title: 'Entrar na mesa', action: 'ASSINAR E ENTRAR' });
  await api('POST', '/auth/wallet-verify', { challengeId: ch.challengeId, nonce: ch.nonce, signature });
  state.me = await api('GET', '/api/me');
  return state.me;
}

/**
 * Entrar por um link de visualização. Aqui o LINK é a autorização, não o convite: carteira sem
 * cadastro é aceita e o cadastro nasce na identificação seguinte (passo SIGNUP).
 */
export async function walletViewLink(token) {
  const ad = getAdapter();
  const acc = await connectVerum({ title: 'Abrir link de visualização' });
  await usarConta(acc);
  const ch = await api('POST', `/api/shared/${token}/wallet-challenge`, { address: acc.address });
  const signature = await walletSign(ch.message, { title: 'Prova de posse da carteira', action: 'ASSINAR E ABRIR' });
  return api('POST', `/api/shared/${token}/wallet-verify`, { challengeId: ch.challengeId, nonce: ch.nonce, signature });
}

/** Garante que a carteira da sessão está neste aparelho e conectada (para assinar aceites). */
export async function ensureWalletForMe() {
  const ad = getAdapter();
  if (!ad.provider) throw new Error(ad.reason || 'Verum Wallet indisponível.');
  const acc = (await listarContas(ad, null)).find((a) => a.address === state.me?.wallet);
  if (!acc) throw new Error('A carteira desta sessão não está neste aparelho. Entre novamente pela Verum Wallet.');
  await usarConta(acc);
  return acc;
}

/** Fluxo genérico: pede challenge, assina na carteira, envia assinatura. */
export async function signFlow(challengeUrl, submitUrl, opts) {
  await ensureWalletForMe();
  const ch = await api('POST', challengeUrl);
  const signature = await walletSign(ch.message, opts);
  return api('POST', submitUrl, { challengeId: ch.challengeId, nonce: ch.nonce, signature });
}

// ---------------------------------------------------------------- formatação
export const fmtDate = (d) => d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const short = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : '—');
export const STATUS_PT = {
  DRAFT: 'Rascunho', PENDING_SIGNATURES: 'Aguardando aceites', LOCKED: 'PARTNERSHIP LOCKED', FUNDED: 'Financiada (simulação)',
  EXECUTING: 'Em execução', SETTLED: 'SETTLED', EXPIRED: 'Expirada', CANCELLED: 'Cancelada',
};
export const ACTION_PT = {
  DEAL_CREATED: 'Operação criada', OFFER_CREATED: 'Oferta criada', BUSINESS_CREATED: 'Negócio criado', PARTICIPANT_INVITED: 'Participante convidado',
  WALLET_CONNECTED: 'Carteira conectada', AGREEMENT_SIGNED: 'Parceria assinada', ALLOCATION_CHANGED: 'Comissões/participantes alterados',
  DEAL_LOCKED: 'PARTNERSHIP LOCKED', DOCUMENT_ADDED: 'Documento adicionado', DOCUMENT_ACCEPTED: 'Documento aceito', SETTLEMENT_CREATED: 'Settlement criado',
  SETTLEMENT_FUNDED: 'Liquidação autorizada (simulação)', SETTLEMENT_EXECUTING: 'Distribuição em execução', SETTLEMENT_SETTLED: 'SETTLED',
  QR_VIEWED: 'QR visualizado', INVITE_CREATED: 'Convite gerado', INVITE_REVOKED: 'Convite revogado', INVITE_REGENERATED: 'Novo link gerado',
  INVITE_OPENED: 'Convite aberto', INVITE_CODE_FAILED: 'Código incorreto', INVITE_CODE_VERIFIED: 'Código confirmado', INVITE_BLOCKED: 'Convite bloqueado',
  INVITE_EXPIRED: 'Convite expirado', WALLET_CHALLENGE_SIGNED: 'Prova de posse assinada', SIGNUP_COMPLETED: 'Cadastro concluído',
  INVITE_COMPLETED: 'Convite concluído', VERSION_SUBMITTED: 'Enviada para assinatura', VERSION_REOPENED: 'Voltou para rascunho',
  VERSION_CREATED: 'Nova versão criada', SIGNATURES_INVALIDATED: 'Assinaturas invalidadas', LOGIN: 'Login', DELETION_REQUESTED: 'Pedido de exclusão (LGPD)',
  VIEW_LINK_CREATED: 'Link de visualização gerado', VIEW_LINK_REVOKED: 'Link de visualização trocado (o anterior parou de valer)',
  VIEW_LINK_ACCESSED: 'Alguém se identificou pelo link de visualização',
};
