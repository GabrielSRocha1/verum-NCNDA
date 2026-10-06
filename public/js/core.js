// Núcleo do cliente: DOM seguro (sem innerHTML com dados), API, toast, sheet, ícones, carteira DEMO.
import { createWalletAdapter } from './wallet-adapter.js';

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

// ---------------------------------------------------------------- Verum Wallet (DEMO)
export function getAdapter() {
  if (!state.adapter) {
    state.adapter = createWalletAdapter({
      demoMode: !!state.config?.demoMode,
      simulateMissing: sessionStorage.getItem('votc-sim-no-wallet') === '1',
      personas: state.personas,
      storage: localStorage,
    });
  }
  return state.adapter;
}
export function resetAdapter() { state.adapter = null; }

/** Seletor de conta da carteira simulada. */
export function walletPick({ title = 'Conectar Verum Wallet', allowCreate = true, only = null } = {}) {
  const ad = getAdapter();
  return new Promise((resolve, reject) => {
    if (!ad.isAvailable()) { reject(Object.assign(new Error('Verum Wallet não encontrada neste aparelho.'), { code: 'NO_WALLET' })); return; }
    let done = false;
    openSheet((s) => {
      const draw = () => {
        const accs = ad.provider.accounts().filter((a) => !only || only.includes(a.key));
        s.render(
          h('h2', {}, title),
          h('p', { class: 'muted small' }, 'Verum Wallet (DEMO). As chaves ficam na carteira; a mesa nunca pede seed, chave privada ou senha.'),
          h('div', { style: 'margin:14px 0' },
            accs.map((a) => h('button', { class: 'wallet-acc', onclick: () => { done = true; s.close(); resolve(a); } },
              h('div', {}, h('b', {}, a.name), h('div', { class: 'small muted' }, a.hint || '')),
              h('span', { class: 'mono small' }, `${a.address.slice(0, 4)}...${a.address.slice(-4)}`)))),
          allowCreate ? h('button', { class: 'btn btn-ghost btn-block', onclick: () => { ad.provider.createGuest(); draw(); } }, icon('plus'), 'Criar nova carteira (DEMO)') : null,
          h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Personas DEMO usam chaves derivadas de sementes públicas. NO REAL FUNDS.'),
        );
      };
      draw();
    }, { label: title, onClose: () => { if (!done) reject(Object.assign(new Error('Conexão cancelada.'), { code: 'CANCELLED' })); } });
  });
}

/** Pedido de assinatura de MENSAGEM, exibido como a carteira exibiria. */
export function walletSign(message, { title = 'Assinar mensagem', action = 'ASSINAR' } = {}) {
  const ad = getAdapter();
  return new Promise((resolve, reject) => {
    let done = false;
    openSheet((s) => {
      s.render(
        h('h2', {}, title),
        h('p', { class: 'muted small', style: 'margin-bottom:10px' }, `Verum Wallet (DEMO) · ${ad.provider.current ? ad.provider.current.address.slice(0, 4) + '...' + ad.provider.current.address.slice(-4) : ''}`),
        h('div', { class: 'sigmsg' }, message),
        h('div', { class: 'btn-row', style: 'margin-top:14px' },
          h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, 'RECUSAR'),
          h('button', { class: 'btn btn-primary', onclick: () => { done = true; const sig = ad.provider.signMessage(message); s.close(); resolve(sig); } }, action)),
      );
    }, { label: title, onClose: () => { if (!done) reject(Object.assign(new Error('Assinatura recusada.'), { code: 'CANCELLED' })); } });
  });
}

/** Login sem senha: challenge → assinatura → sessão curta. */
export async function walletLogin(accountKey = null) {
  const ad = getAdapter();
  const acc = accountKey ? ad.provider.accounts().find((a) => a.key === accountKey) : await walletPick({ title: 'Entrar com a Verum Wallet' });
  ad.provider.connect(acc.key);
  const ch = await api('POST', '/auth/wallet-challenge', { address: acc.address });
  const signature = await walletSign(ch.message, { title: 'Entrar na mesa', action: 'ASSINAR E ENTRAR' });
  await api('POST', '/auth/wallet-verify', { challengeId: ch.challengeId, nonce: ch.nonce, signature });
  state.me = await api('GET', '/api/me');
  return state.me;
}

/** Garante que a carteira simulada está conectada na conta da sessão (para assinar aceites). */
export function ensureWalletForMe() {
  const ad = getAdapter();
  if (!ad.provider) throw new Error('Verum Wallet indisponível.');
  const acc = ad.provider.accounts().find((a) => a.address === state.me?.wallet);
  if (!acc) throw new Error('A carteira desta sessão não está neste aparelho. Entre novamente pela Verum Wallet.');
  ad.provider.connect(acc.key);
  return acc;
}

/** Fluxo genérico: pede challenge, assina na carteira, envia assinatura. */
export async function signFlow(challengeUrl, submitUrl, opts) {
  ensureWalletForMe();
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
};
