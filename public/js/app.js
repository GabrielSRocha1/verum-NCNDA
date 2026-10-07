// VERUM NCNDA PRIVATE DAPP — cliente (PWA). Roteamento por hash; convite em /i/:token.
import {
  h, add, clear, icon, api, toast, copy, openSheet, qrSvg, state, brand, getAdapter, walletLogin, walletSign, signFlow,
  walletViewLink, walletPick, connectVerum, temCarteiraReal, resetAdapter,
  ensureWalletForMe, fmtDate, short, STATUS_PT, ACTION_PT,
} from './core.js';
import { qualCard, partnerCard, openQrSheet, openInviteSheet, showInviteResult, commissionTable, legChips } from './components.js';
import { startInvite } from './invite.js';
import { onVerumReady, iniciarConector, dentroDeIframe } from './verum-provider.js';
import { pctToBps, bpsToPct } from './onboarding-logic.js';

const root = document.getElementById('app');
// Download da Verum Wallet. VERUM_WALLET_DOWNLOAD_URL (config) tem prioridade; este é o padrão.
const WALLET_DOWNLOAD_URL = 'https://download.verumcrypto.com';
const ROLE_LABEL = {
  VENDEDOR: 'Vendedor', GRUPO_VENDA: 'Grupo Venda', INTERMEDIACAO_VENDA: 'Intermediação Venda', PAY_MASTER: 'Pay Master / Ligação',
  INTERMEDIACAO_COMPRA: 'Intermediação Compra', GRUPO_COMPRA: 'Grupo Compra', COMPRADOR: 'Comprador',
};
const KIND_LABEL = { PAGADOR: 'Pagador', GRUPO_VENDA: 'Grupo Venda', GRUPO_COMPRA: 'Grupo Compra', INTERMEDIACAO: 'Intermediação', COMISSAO: 'Comissão', RESIDUO: 'Resíduo' };
const POLICY_LABEL = {
  TO_PAY_MASTER: 'Resíduo para o Pay Master / Ligação (padrão)', TO_PAYER: 'Resíduo para o Pagador',
  TO_SELL_INTERMEDIARY: 'Resíduo para a Intermediação Venda', TO_BUY_INTERMEDIARY: 'Resíduo para a Intermediação Compra',
};
const INVITE_STATUS = { ATIVO: 'ATIVO', ABERTO: 'ABERTO', CONCLUIDO: 'CONCLUÍDO', EXPIRADO: 'EXPIRADO', REVOGADO: 'REVOGADO', BLOQUEADO: 'BLOQUEADO' };
const TABS = [['resumo', 'Resumo'], ['participantes', 'Participantes'], ['estrutura', 'Estrutura Comercial'], ['documentos', 'Documentos'], ['compliance', 'Compliance'], ['historico', 'Histórico'], ['settlement', 'Settlement']];

// ================================================================= boot
async function boot() {
  // A Verum Wallet abre as plataformas parceiras dentro de um iframe dela, e quem cria
  // window.verum é o conector embarcado NESTA página — mas só depois de init(). Pedir primeiro,
  // procurar depois. Sem conector embarcado, nada acontece e a mesa segue como hoje.
  state.verumConector = await iniciarConector();
  try {
    state.config = await api('GET', '/api/config');
    if (state.config.demoMode) state.personas = (await api('GET', '/api/demo/personas')).personas;
  } catch { state.config = { demoMode: false }; }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  const m = location.pathname.match(/^\/i\/([A-Za-z0-9_-]{43})\/?$/);
  if (m) { history.replaceState(null, '', location.pathname); startInvite(root, m[1]); return; }
  if (location.pathname.startsWith('/i/')) { startInvite(root, ''); return; }
  try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  window.addEventListener('hashchange', () => { render(); });
  render();
  // Extensão de navegador costuma injetar DEPOIS do primeiro render — e o adapter fica em cache
  // sem ela. Isto observa a chegada e refaz a tela. Vem DEPOIS do render para a checagem imediata
  // não desenhar duas vezes.
  onVerumReady(() => { resetAdapter(); render(); });
}

function ribbon() {
  return state.config?.demoMode ? h('div', { class: 'demo-ribbon' }, 'DEMO / TESTNET — NO REAL FUNDS') : null;
}

// ================================================================= roteamento
const lastScroll = {};
let currentRoute = null;
function parseRoute() {
  const p = (location.hash.replace(/^#/, '') || '/home').split('/').filter(Boolean);
  return { name: p[0] || 'home', id: p[1], sub: p[2], tab: p[3] };
}

async function render() {
  if (currentRoute) lastScroll[currentRoute] = window.scrollY;
  const route = parseRoute();
  const key = location.hash || '#/home';
  currentRoute = key;
  clear(root);
  add(root, ribbon());
  // Link de visualização: a entrada é pelo próprio link, não pelo login da mesa — quem recebeu o
  // link pode nem ter cadastro ainda. Sem este desvio, cairia no login e seria recusado.
  if (!state.me && route.name === 'm' && route.id) { root.append(await viewerLinkPage(route.id)); return; }
  // Solicitação de acesso: por definição, quem abre ainda não tem cadastro — fora do shell também.
  if (!state.me && route.name === 'solicitar') { root.append(accessRequestPage()); return; }
  if (!state.me) { root.append(loginPage()); return; }
  const main = h('main', { class: 'main', id: 'main' });
  root.append(h('div', { class: 'shell' }, sidebar(route), main), bottomNav(route));
  main.append(topbar());
  const body = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  main.append(body);
  try {
    const page = await pageFor(route);
    if (currentRoute !== key) return;
    clear(body); body.append(page);
    requestAnimationFrame(() => window.scrollTo(0, lastScroll[key] ?? 0));
  } catch (e) {
    if (e.status === 401) { state.me = null; render(); return; }
    clear(body);
    body.append(h('div', { class: 'empty-state' }, e.message || 'Não foi possível carregar.', h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn btn-ghost btn-sm', href: '#/home' }, 'Voltar para a Home'))));
  }
}

function pageFor(r) {
  switch (r.name) {
    case 'home': return homePage();
    case 'dashboard': return dashboardPage();
    case 'deals': return listPage('UNICA');
    case 'parcerias': return listPage('PERMANENTE');
    case 'carteira': return walletPage();
    case 'perfil': return profilePage();
    case 'convites': return invitesPage();
    case 'solicitar': return Promise.resolve(h('div', {}, pageHead('Solicitar cadastro'),
      h('div', { class: 'empty-state' }, 'Você já tem cadastro nesta mesa — não precisa solicitar acesso.',
        h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn btn-ghost btn-sm', href: '#/dashboard' }, 'Ir para o Dashboard')))));
    case 'participantes': return pickDealPage('participantes', 'Participantes', 'Quem ocupa cada função, o percentual travado de cada um e quem já assinou. Escolha a mesa.');
    case 'documentos': return pickDealPage('documentos', 'Documentos', 'Documentos ficam dentro de cada Deal Room, com versão, hash e aceites.');
    case 'compliance': return pickDealPage('compliance', 'Compliance', 'Status apenas informativos. A Verum NCNDA não emite aprovação regulatória nem garante legalidade de operações.');
    case 'settlement': return pickDealPage('settlement', 'Settlement', 'Distribuição exata por bps, com resíduo explícito. No DEMO, tudo é simulado.');
    case 'auditoria': return auditPage();
    case 'nova': return newOfferPage();
    case 'deal': return r.sub === 'room' ? dealRoomPage(r.id, r.tab || 'resumo') : partnersPage(r.id);
    case 'm': return sharedRoomPage(r.id, r.sub || 'resumo');
    default: return homePage();
  }
}

function navItems(desktop) {
  return desktop
    ? [['dashboard', 'Dashboard', 'home'], ['deals', 'Deals', 'deals'], ['parcerias', 'Parcerias', 'partner'], ['participantes', 'Participantes', 'people'], ['convites', 'Convites', 'invite'], ['documentos', 'Documentos', 'docs'], ['compliance', 'Compliance', 'shield'], ['settlement', 'Settlement', 'settle'], ['auditoria', 'Auditoria', 'audit'], ['perfil', 'Perfil', 'profile']]
    : [['home', 'Home', 'home'], ['deals', 'Deals', 'deals'], ['parcerias', 'Parcerias', 'partner'], ['carteira', 'Carteira', 'wallet'], ['perfil', 'Perfil', 'profile']];
}
function isCurrent(r, name) {
  if (r.name === name) return true;
  if (name === 'home' && (r.name === 'deal' || r.name === 'nova')) return true;
  if (name === 'dashboard' && (r.name === 'home' || r.name === 'deal' || r.name === 'nova')) return true;
  return false;
}
function sidebar(r) {
  return h('nav', { class: 'sidebar', 'aria-label': 'Navegação principal' }, brand(),
    navItems(true).map(([n, l, i]) => h('a', { href: `#/${n}`, 'aria-current': isCurrent(r, n) ? 'page' : null }, icon(i), l)));
}
function bottomNav(r) {
  return h('nav', { class: 'bottomnav', 'aria-label': 'Navegação' },
    navItems(false).map(([n, l, i]) => h('a', { href: `#/${n}`, 'aria-current': isCurrent(r, n) ? 'page' : null }, icon(i), l)));
}
function topbar() {
  return h('div', { class: 'topbar' }, brand(),
    h('div', { class: 'who' }, h('b', {}, state.me.fullName), h('span', { class: 'mono' }, short(state.me.wallet))));
}
function pageHead(title, ...right) {
  return h('div', { class: 'section-title', style: 'margin-top:0' }, h('h1', {}, title), h('div', { class: 'btn-row' }, right));
}
function back(href, label = 'Voltar') {
  return h('a', { class: 'btn btn-ghost btn-sm', href, style: 'margin-bottom:14px' }, icon('back'), label);
}

// ================================================================= login (sem senha)
function loginPage() {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const enter = async () => {
    err.textContent = '';
    try { await walletLogin(); toast('Sessão iniciada.'); render(); }
    catch (e) {
      if (e.code === 'CANCELLED') return;
      err.textContent = e.code === 'NO_WALLET' ? 'Verum Wallet não encontrada neste aparelho.' : e.message;
    }
  };
  // Quem chega por link de visualização precisa saber o que está abrindo antes de assinar.
  const shared = location.hash.startsWith('#/m/');
  return h('main', { class: 'gate' }, brand(),
    h('h1', {}, shared ? 'Visualizar operação' : 'Mesa OTC privada'),
    h('p', { class: 'lead' }, shared
      ? 'Você abriu um link de visualização de uma operação. Entre com a Verum Wallet para ver a mesa — é só leitura: você não assina nem altera nada.'
      : 'Acesso só por convite. Quem já concluiu o convite entra assinando com a Verum Wallet — sem senha.'),
    h('button', { class: 'btn btn-primary btn-block', onclick: enter }, 'ENTRAR COM A VERUM WALLET'),
    h('a', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:10px',
      href: state.config?.walletDownloadUrl || WALLET_DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer',
    }, 'BAIXAR VERUM WALLET'), err,
    state.config?.demoMode ? h('div', { class: 'notice notice-info', style: 'margin-top:20px' },
      'DEMO: entre como Rafael Monteiro (Pay Master 01, admin) para ver as três mesas. As demais personas são os parceiros das mesas.') : null,
    h('p', { class: 'small muted', style: 'margin-top:20px' }, 'A mesa nunca pede seed, chave privada ou senha. Não é exchange, corretora nem marketplace aberto.'),
    // Porta de entrada de quem ainda não tem convite: discreta de propósito, e só quando o
    // responsável pela mesa ligou o recebimento de solicitações.
    state.config?.accessRequests ? h('p', { class: 'small muted', style: 'margin-top:18px;text-align:center' },
      'Ainda não tem acesso? ', h('a', { href: '#/solicitar' }, 'Solicitar cadastro')) : null);
}

const PAISES = [['BR', 'Brasil'], ['PY', 'Paraguai'], ['AR', 'Argentina'], ['UY', 'Uruguai'], ['US', 'Estados Unidos'], ['PT', 'Portugal'], ['AE', 'Emirados Árabes'], ['CH', 'Suíça']];

/**
 * Solicitação de acesso: como entra quem não tem de quem receber convite — o primeiro Pay Master.
 * Enviar NÃO cria conta: cria conta é o responsável pela mesa, pelo comando, depois de ler quem é.
 * A carteira é comprovada por assinatura aqui, para ninguém cadastrar o endereço de outra pessoa.
 */
function accessRequestPage() {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const f = {
    fullName: h('input', { autocomplete: 'name', required: true, maxlength: '120' }),
    email: h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '254' }),
    phone: h('input', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '+55 11 91234-5678', maxlength: '24' }),
    country: h('select', {}, PAISES.map(([v, l]) => h('option', { value: v }, l))),
    organization: h('input', { required: true, maxlength: '120', placeholder: 'Empresa ou mesa que você representa' }),
    referral: h('input', { maxlength: '120', placeholder: 'Nome de quem indicou (opcional)' }),
    note: h('textarea', { maxlength: '500', rows: '3', placeholder: 'O que você pretende operar (opcional)' }),
  };
  const temReal = temCarteiraReal();
  const btn = h('button', { class: 'btn btn-primary btn-block' }, temReal ? 'CONECTAR VERUM WALLET E ENVIAR' : 'CONECTAR CARTEIRA E ENVIAR');
  const pronto = (email, avisoEnviado) => clear(document.getElementById('app')).append(
    h('main', { class: 'gate' }, brand('Solicitação enviada'),
      h('h1', {}, 'Solicitação enviada'),
      // Só promete e-mail quando o envio está de fato configurado no servidor. Prometer retorno
      // por e-mail com SMTP desligado seria combinar algo que ninguém vai cumprir.
      // Só afirma que o e-mail saiu quando o servidor confirmou o envio desta mensagem.
      state.config?.emailEnabled && avisoEnviado
        ? h('p', { class: 'lead' }, 'Seus dados e a carteira que você assinou ficaram registrados. Acabamos de enviar uma confirmação, e ',
          h('b', {}, 'o retorno vai para o e-mail que você cadastrou'),
          email ? h('span', { class: 'mono' }, ` (${email})`) : null, '.')
        : h('p', { class: 'lead' }, 'Seus dados e a carteira que você assinou ficaram registrados. O responsável pela mesa vai analisar e retornar pelo contato que você informou.'),
      h('p', { class: 'notice notice-info', style: 'margin-top:14px' },
        'Aprovado, você entra direto pela Verum Wallet — sem senha e sem novo cadastro, usando a mesma carteira que assinou agora.'),
      h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Nada foi criado ainda: enquanto não houver aprovação, esta carteira não tem acesso à mesa.'),
      h('a', { class: 'btn btn-ghost btn-block', style: 'margin-top:18px', href: '#/home' }, 'VOLTAR')));

  const enviar = async (e) => {
    e.preventDefault();
    err.textContent = ''; btn.disabled = true;
    try {
      const dados = {
        fullName: f.fullName.value, email: f.email.value, phone: f.phone.value, country: f.country.value,
        organization: f.organization.value,
        ...(f.referral.value.trim() ? { referral: f.referral.value.trim() } : {}),
        ...(f.note.value.trim() ? { note: f.note.value.trim() } : {}),
      };
      // Com a extensão instalada, conecta nela direto; só cai no seletor quando a única coisa
      // disponível é a carteira DEMO (caso de teste).
      const acc = await connectVerum({ title: 'Conectar Verum Wallet' });
      const ad = getAdapter();
      ad.use(acc.provider ?? ad.provider);
      await ad.provider.connect(acc.key);
      const ch = await api('POST', '/access/request/wallet-challenge', { address: acc.address });
      const signature = await walletSign(ch.message, { title: 'Prova de posse da carteira', action: 'ASSINAR E ENVIAR' });
      const env = await api('POST', '/access/request', { challengeId: ch.challengeId, nonce: ch.nonce, signature, ...dados });
      pronto(dados.email, env.emailSent);
    } catch (ex) {
      if (ex.code !== 'CANCELLED') err.textContent = ex.message;
      btn.disabled = false;
    }
  };

  return h('main', { class: 'gate' }, brand('Solicitação de acesso'),
    h('h1', {}, 'Solicitar cadastro'),
    h('p', { class: 'lead' }, 'Esta mesa é privada e não tem cadastro aberto. Conte quem você é e qual carteira vai usar: o responsável analisa e, se aprovar, você entra assinando com a Verum Wallet.'),
    h('form', { onsubmit: enviar },
      h('label', { class: 'field' }, h('span', {}, 'Nome completo'), f.fullName),
      h('label', { class: 'field' }, h('span', {}, 'E-mail'), f.email),
      h('label', { class: 'field' }, h('span', {}, 'Telefone / WhatsApp'), f.phone),
      h('label', { class: 'field' }, h('span', {}, 'País'), f.country),
      h('label', { class: 'field' }, h('span', {}, 'Organização'), f.organization),
      h('label', { class: 'field' }, h('span', {}, 'Quem indicou você'), f.referral),
      h('label', { class: 'field' }, h('span', {}, 'Observação'), f.note),
      err, btn),
    h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Ao enviar você assina uma mensagem que prova que a carteira é sua. Não é transação e não movimenta fundos. A mesa nunca pede seed, chave privada ou senha.'),
    // Dizer QUAL carteira vai assinar, antes do clique. Sem isto, quem instalou a extensão e viu a
    // lista de personas DEMO conclui — com razão — que a mesa não achou a carteira dele.
    temReal ? null : h('div', { class: 'notice notice-risk', style: 'margin-top:14px' },
      'A Verum Wallet não foi detectada neste navegador. ',
      state.config?.demoMode ? 'Para o teste, a assinatura vai usar a carteira DEMO.' : 'Abra esta mesa pelo app da Verum para conectar sua carteira.'),
    temReal ? null : walletDiagnostico(getAdapter()),
    state.config?.demoMode ? h('p', { class: 'small muted', style: 'margin-top:26px;text-align:center' }, 'DEMO / TESTNET — NO REAL FUNDS') : null);
}

// ================================================================= Home e listas
async function homePage() {
  const { deals } = await api('GET', '/api/deals');
  return h('div', {},
    pageHead('Mesas', h('a', { class: 'btn btn-blue btn-sm', href: '#/nova' }, icon('plus'), 'Nova oferta')),
    deals.length
      ? h('div', { class: 'stack' }, deals.map((d) => qualCard(d, { onClick: () => { location.hash = `#/deal/${d.id}`; } })))
      : h('div', { class: 'empty-state' }, 'Nenhuma mesa ainda. Crie uma oferta ou aguarde um convite.'));
}

/** Atalhos diretos para as abas da mesa, sem passar pela Tela de Parceiros. */
const cardActions = (d) => [
  h('a', { class: 'btn btn-ghost btn-sm', href: `#/deal/${d.id}/room/participantes` }, 'Ver participantes'),
  h('a', { class: 'btn btn-ghost btn-sm', href: `#/deal/${d.id}/room/compliance` }, 'Compliance'),
];

async function listPage(kind) {
  const { deals } = await api('GET', '/api/deals');
  const list = deals.filter((d) => d.offer.kind === kind);
  const title = kind === 'UNICA' ? 'Deals — ofertas únicas' : 'Parcerias permanentes';
  if (kind === 'PERMANENTE') {
    const byBiz = new Map();
    for (const d of list) { const k = d.offer.businessName ?? '—'; if (!byBiz.has(k)) byBiz.set(k, []); byBiz.get(k).push(d); }
    return h('div', {}, pageHead(title, h('a', { class: 'btn btn-blue btn-sm', href: '#/nova' }, icon('plus'), 'Nova oferta')),
      list.length ? [...byBiz.entries()].map(([biz, ds]) => h('section', {},
        h('div', { class: 'section-title' }, h('h2', {}, biz), h('span', { class: 'small muted' }, `${ds.length} oferta(s)`)),
        h('div', { class: 'stack' }, ds.map((d) => qualCard(d, { onClick: () => { location.hash = `#/deal/${d.id}`; }, actions: cardActions(d) })))))
        : h('div', { class: 'empty-state' }, 'Nenhuma parceria permanente.'));
  }
  return h('div', {}, pageHead(title, h('a', { class: 'btn btn-blue btn-sm', href: '#/nova' }, icon('plus'), 'Nova oferta')),
    list.length ? h('div', { class: 'stack' }, list.map((d) => qualCard(d, { onClick: () => { location.hash = `#/deal/${d.id}`; }, actions: cardActions(d) })))
      : h('div', { class: 'empty-state' }, 'Nenhuma oferta única.'));
}

async function dashboardPage() {
  const d = await api('GET', '/api/dashboard');
  let invites = [];
  try { invites = (await api('GET', '/invitations')).invitations; } catch { invites = []; }
  const mini = (x) => h('a', { class: 'panel', href: `#/deal/${x.id}`, style: 'display:block;text-decoration:none' },
    h('div', { class: 'row' }, h('b', {}, x.offer.businessName ? `${x.offer.businessName} · ${x.offer.title}` : x.offer.title), h('span', { class: 'kn' }, x.signatures.label)),
    h('div', { class: 'row small muted', style: 'margin-top:4px' }, h('span', {}, `${x.direction} · grade ${x.offer.grade.label}`), h('span', {}, STATUS_PT[x.version.status])));
  return h('div', {},
    pageHead('Dashboard', h('a', { class: 'btn btn-blue btn-sm', href: '#/nova' }, icon('plus'), 'Nova oferta')),
    h('div', { class: 'counters' },
      h('div', { class: 'counter' }, h('b', {}, d.counters.active), h('span', {}, 'Operações ativas')),
      h('div', { class: 'counter' }, h('b', {}, d.counters.awaiting), h('span', {}, 'Aguardando aceite')),
      h('div', { class: 'counter' }, h('b', {}, d.counters.partnerships), h('span', {}, 'Parcerias')),
      h('div', { class: 'counter' }, h('b', {}, d.counters.settled), h('span', {}, 'Concluídas'))),
    h('div', { class: 'section-title' }, h('h2', {}, 'Minhas Operações')),
    h('div', { class: 'stack' }, d.deals.filter((x) => x.offer.kind === 'UNICA').map(mini)),
    h('div', { class: 'section-title' }, h('h2', {}, 'Minhas Parcerias')),
    h('div', { class: 'stack' }, d.deals.filter((x) => x.offer.kind === 'PERMANENTE').map(mini)),
    h('div', { class: 'section-title' }, h('h2', {}, 'Convites'), h('a', { class: 'small', href: '#/convites' }, 'Ver todos')),
    invites.length ? h('div', { class: 'panel list' }, invites.slice(0, 5).map((i) => h('div', { class: 'row' },
      h('span', {}, `${i.dealCode} · ${i.role}`), h('span', { class: 'chip chip-status' }, INVITE_STATUS[i.status]))))
      : h('p', { class: 'muted small' }, 'Nenhum convite gerado.'),
    h('div', { class: 'section-title' }, h('h2', {}, 'Atividade')),
    h('div', { class: 'panel list' }, d.activity.map((a) => h('div', { class: 'row small' },
      h('span', {}, `${a.dealCode} · ${ACTION_PT[a.action] ?? a.action}`), h('span', { class: 'muted' }, fmtDate(a.at))))));
}

// ================================================================= Tela de Parceiros (pilha de cards)
async function partnersPage(id) {
  const d = await api('GET', `/api/deals/${id}`);
  const [from, to] = d.direction.split(' → ');
  return h('div', {},
    back('#/home', 'Mesas'),
    h('div', { class: 'op-summary' },
      h('div', { style: 'flex:1 1 100%' }, h('div', { class: 'qual-business' }, d.offer.businessName ?? d.offer.kindLabel), h('div', { class: 'qual-title' }, d.offer.title)),
      h('div', { class: 'direction' }, h('span', {}, from), h('span', { class: 'arrow' }, '→'), h('span', {}, to)),
      h('span', { class: 'small' }, d.offer.volume),
      h('span', { class: 'mono', style: 'font-weight:700' }, `grade ${d.offer.grade.label}`),
      h('span', { class: 'kn' }, d.signatures.label),
      h('div', { style: 'flex:1 1 100%' }, legChips(d.legs))),
    d.honestyNotice ? h('div', { class: 'notice notice-risk', style: 'margin-bottom:16px' }, d.honestyNotice) : null,
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('h2', {}, 'Parceiros'),
      h('a', { class: 'btn btn-blue btn-sm', href: `#/deal/${id}/room/resumo` }, 'Abrir Deal Room')),
    h('div', { class: 'partners' }, d.participants.map((p, i) => partnerCard(p, i, { onClick: () => openQrSheet(d, p) }))),
    h('p', { class: 'small muted', style: 'margin-top:16px' }, 'Toque em um parceiro para abrir o QR de pagamento. Contatos só aparecem para participantes com convite concluído.'));
}

// ================================================================= Deal Room
async function dealRoomPage(id, tab) {
  const d = await api('GET', `/api/deals/${id}`);
  return roomPage(d, tab, (k) => `#/deal/${id}/room/${k}`, back(`#/deal/${id}`, 'Parceiros'));
}

/** Mesa aberta por link de visualização: mesmas abas, nenhuma ação. */
async function sharedRoomPage(token, tab) {
  let gate;
  // 401 aqui = sessão expirou no meio do caminho: volta para a entrada do link, não para o login
  // da mesa (quem abriu o link pode nem ter cadastro).
  try { gate = await api('GET', `/api/shared/${token}/gate`); }
  catch (e) { if (e.status === 401) return viewerConnectPage(token); throw e; }
  if (!gate.registered) return viewerSignupPage(token, gate);
  const d = await api('GET', `/api/shared/${token}`);
  return roomPage(d, tab, (k) => `#/m/${token}/${k}`,
    h('div', { class: 'notice notice-info', style: 'margin-bottom:14px' },
      'Visualização compartilhada — só leitura. Você vê a operação inteira, mas não pode assinar, convidar nem alterar nada.'));
}

/**
 * Link de visualização aberto por quem ainda não tem sessão — caso normal de carteira sem
 * cadastro. Decide entre conectar a carteira e se identificar olhando o portão: ele responde 401
 * enquanto não houver carteira provada, e passa a responder quando houver.
 *
 * Isto vive FORA do shell do app de propósito: o shell só desenha páginas quando há perfil
 * carregado, e aqui ainda não há — a conta só nasce no fim da identificação.
 */
async function viewerLinkPage(token) {
  let gate = null;
  try { gate = await api('GET', `/api/shared/${token}/gate`); }
  catch (e) {
    if (e.status === 401) return viewerConnectPage(token);                     // falta provar a carteira
    return h('main', { class: 'gate' }, brand('Link de visualização'),
      h('h1', {}, 'Link indisponível'), h('p', { class: 'lead' }, e.message || 'Este link de visualização não é mais válido.'));
  }
  return gate.registered ? viewerConnectPage(token) : viewerSignupPage(token, gate);
}

/**
 * Primeira tela do link: não mostra nada da operação. O cabeçalho da mesa só aparece depois da
 * carteira provada, e a operação só depois da identificação.
 */
function viewerConnectPage(token) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn btn-primary btn-block' }, 'CONECTAR VERUM WALLET');
  btn.onclick = async () => {
    err.textContent = ''; btn.disabled = true;
    try {
      const r = await walletViewLink(token);
      // Carteira com cadastro já entra na sessão; carteira nova segue sem sessão para a
      // identificação, e quem decide isso é o portão no próximo render.
      if (r.step === 'GATE') { try { state.me = await api('GET', '/api/me'); } catch { /* segue sem perfil */ } }
      render();
    } catch (e) {
      if (e.code !== 'CANCELLED') err.textContent = e.message;
      btn.disabled = false;
    }
  };
  return h('main', { class: 'gate' }, brand('Link de visualização'),
    h('h1', {}, 'Visualização de operação'),
    h('p', { class: 'lead' }, 'Você recebeu um link para ver uma operação em modo leitura. Conecte a Verum Wallet para continuar: você assina uma mensagem que prova que a carteira é sua. Não é transação e não movimenta fundos.'),
    btn, err,
    h('p', { class: 'small muted', style: 'margin-top:18px' }, 'Depois da carteira você se identifica, e só então a operação aparece. Visualizar não permite assinar, convidar nem alterar nada.'),
    state.config?.demoMode ? h('p', { class: 'small muted', style: 'margin-top:26px;text-align:center' }, 'DEMO / TESTNET — NO REAL FUNDS') : null);
}

/** Primeiro acesso ao link: a pessoa se identifica antes de ver a operação. */
function viewerSignupPage(token, gate) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const f = {
    fullName: h('input', { autocomplete: 'name', required: true, maxlength: '120', value: gate.prefill?.fullName || '' }),
    email: h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '254', value: gate.prefill?.email || '' }),
    phone: h('input', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '+55 11 91234-5678', maxlength: '24', value: gate.prefill?.phone || '' }),
    country: h('select', {}, [['BR', 'Brasil'], ['PY', 'Paraguai'], ['AR', 'Argentina'], ['UY', 'Uruguai'], ['US', 'Estados Unidos'], ['PT', 'Portugal'], ['AE', 'Emirados Árabes'], ['CH', 'Suíça']].map(([v, l]) => h('option', { value: v, selected: (gate.prefill?.country || 'BR') === v ? '' : null }, l))),
  };
  const btn = h('button', { class: 'btn btn-primary btn-block' }, 'IDENTIFICAR-SE E VER A OPERAÇÃO');
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = ''; btn.disabled = true;
    try {
      await api('POST', `/api/shared/${token}/register`, { fullName: f.fullName.value, email: f.email.value, phone: f.phone.value, country: f.country.value });
      // o cadastro pode ter preenchido o perfil do convidado: recarrega para a barra do topo acertar o nome
      try { state.me = await api('GET', '/api/me'); } catch { /* mantém o que já tinha */ }
      toast('Identificação registrada.'); render();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  };
  return h('div', {},
    h('div', { class: 'panel', style: 'margin-bottom:16px' },
      h('div', { class: 'row' }, h('span', { class: 'chip chip-seal' }, gate.deal.kindLabel), h('span', { class: 'mono small' }, gate.deal.code)),
      h('div', { class: 'direction', style: 'font-size:26px' }, gate.deal.direction),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Operação'), h('dd', {}, gate.deal.businessName ? `${gate.deal.businessName} — ${gate.deal.title}` : gate.deal.title),
        h('dt', {}, 'Carteira conectada'), h('dd', { class: 'mono' }, gate.walletShort))),
    h('h1', {}, 'Identifique-se para ver a operação'),
    h('p', { class: 'lead' }, 'Este é um link de visualização. Antes de abrir a operação, informe seus dados: eles ficam visíveis para o Pay Master 01 desta mesa, junto da carteira que você conectou.'),
    h('form', { onsubmit: submit },
      h('label', { class: 'field' }, h('span', {}, 'Nome completo'), f.fullName),
      h('label', { class: 'field' }, h('span', {}, 'E-mail'), f.email),
      h('label', { class: 'field' }, h('span', {}, 'Telefone / WhatsApp'), f.phone),
      h('label', { class: 'field' }, h('span', {}, 'País'), f.country), err, btn),
    h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Depois de se identificar você vê a operação só leitura: não assina, não convida e não altera nada.'));
}

async function roomPage(d, tab, hrefFor, head) {
  const content = h('div', {});
  const page = h('div', {}, head,
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('div', {}, h('div', { class: 'qual-business' }, `${d.code} · v${d.version.no}`), h('h1', {}, d.offer.businessName ? `${d.offer.businessName} — ${d.offer.title}` : d.offer.title)),
      h('span', { class: `chip ${['LOCKED', 'SETTLED'].includes(d.version.status) ? 'chip-ok' : 'chip-status'}` }, STATUS_PT[d.version.status])),
    h('nav', { class: 'tabs', 'aria-label': 'Abas da Deal Room' }, TABS.map(([k, l]) => h('a', { href: hrefFor(k), 'aria-current': tab === k ? 'page' : null }, l))),
    content);
  const builders = { resumo: tabResumo, participantes: tabParticipantes, estrutura: tabEstrutura, documentos: tabDocumentos, compliance: tabCompliance, historico: tabHistorico, settlement: tabSettlement };
  content.append(await (builders[tab] ?? tabResumo)(d));
  return page;
}

/** Sub-rotas da mesa: pelo token quando aberta por link, pelo id quando é a sua mesa. */
const dealBase = (d) => (d.sharedToken ? `/api/shared/${d.sharedToken}` : `/api/deals/${d.id}`);

/** Link de visualização da mesa. Exclusivo do admin (Pay Master 01). */
function openShareSheet(d) {
  const msg = (url) => [`VERUM NCNDA — ${d.code}`, d.offer.businessName ? `${d.offer.businessName} — ${d.offer.title}` : d.offer.title,
    `Visualização da operação (só leitura): ${url}`,
    'Para abrir é preciso a Verum Wallet: a pessoa assina com a carteira dela e vê a mesa, sem poder alterar nada.'].join('\n');
  openSheet((s) => {
    const draw = (r) => s.render(
      h('h2', {}, 'Link de visualização'),
      h('p', { class: 'muted small' }, `Mesa ${d.code}. Quem abrir este link vê a operação inteira, só leitura, e precisa entrar com a Verum Wallet. Só você, como Pay Master 01, pode gerar e regerar o link.`),
      // Na prévia não há servidor: avisa antes de a pessoa enviar o link e ele falhar do outro lado.
      state.config?.preview ? h('p', { class: 'notice notice-risk', style: 'margin:10px 0' },
        'PRÉVIA: este link só abre NESTE navegador. Não há servidor aqui — cada aparelho guarda a própria mesa. Enviar para outra pessoa não vai funcionar.') : null,
      r.url
        ? h('div', {},
          h('label', { class: 'field' }, h('span', {}, 'Link da mesa'), h('div', { class: 'sigmsg' }, r.url)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-blue', onclick: () => copy(r.url, 'Link copiado') }, 'COPIAR LINK'),
            h('button', {
              class: 'btn btn-ghost', onclick: async () => {
                if (navigator.share) { try { await navigator.share({ title: `VERUM NCNDA — ${d.code}`, text: msg(r.url) }); } catch { /* cancelado */ } }
                else copy(msg(r.url), 'Compartilhamento indisponível: mensagem copiada');
              },
            }, 'COMPARTILHAR')),
          h('details', { style: 'margin-top:14px' }, h('summary', { class: 'small muted' }, 'Ver mensagem pronta'), h('div', { class: 'sigmsg', style: 'margin-top:8px' }, msg(r.url))),
          h('p', { class: 'notice notice-risk', style: 'margin-top:14px' }, 'Quem tem o link consegue repassá-lo. Se vazar, gere um novo: o anterior para de funcionar na hora.'),
          h('button', {
            class: 'btn btn-ghost btn-block', style: 'margin-top:10px', onclick: async () => {
              try { draw(await api('POST', `/api/deals/${d.id}/share-link/regenerate`)); toast('Link novo gerado. O anterior foi invalidado.'); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, 'GERAR NOVO LINK (invalida o atual)'))
        : h('div', {},
          h('p', { class: 'muted small', style: 'margin-bottom:12px' }, 'Esta mesa ainda não tem link de visualização.'),
          h('button', {
            class: 'btn btn-primary btn-block', onclick: async () => {
              try { draw(await api('POST', `/api/deals/${d.id}/share-link`)); toast('Link gerado.'); }
              catch (e) { toast(e.message, 'err'); }
            },
          }, 'GERAR LINK')),
      h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:14px', onclick: () => s.close() }, 'FECHAR'),
    );
    draw({ url: null });
    api('GET', `/api/deals/${d.id}/share-link`).then(draw).catch((e) => {
      // Mesmo recurso opcional da aba Participantes: sem a rota, diz o que é em vez de despejar
      // "Route GET:/api/... not found" na cara de quem clicou.
      if (e.status === 404) {
        s.render(h('h2', {}, 'Link de visualização'),
          h('p', { class: 'notice notice-info' }, 'Este servidor não oferece link de visualização da mesa. O recurso existe na pré-visualização; para valer aqui, precisa ser implementado no servidor.'),
          h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:14px', onclick: () => s.close() }, 'FECHAR'));
        return;
      }
      toast(e.message, 'err');
    });
  }, { label: 'Link de visualização' });
}
const reload = () => render();

function tabResumo(d) {
  const v = d.version;
  const actions = h('div', { class: 'btn-row', style: 'margin-top:14px' });
  const notes = [];
  if (v.status === 'PENDING_SIGNATURES' && d.me && !d.me.signed) {
    actions.append(h('button', {
      class: 'btn btn-primary', onclick: async () => {
        try {
          const r = await signFlow(`/api/deals/${d.id}/agreement/challenge`, `/api/deals/${d.id}/agreement/sign`, { title: 'ASSINAR PARCERIA', action: 'ASSINAR PARCERIA' });
          toast(r.locked ? 'Todos assinaram: PARTNERSHIP LOCKED.' : `Assinatura registrada (${r.k}/${r.n}).`); reload();
        } catch (e) { if (e.code !== 'CANCELLED') toast(e.message, 'err'); }
      },
    }, 'ASSINAR PARCERIA'));
    notes.push('Assinar a parceria é assinatura de mensagem com o hash dos termos: não movimenta fundos.');
  }
  if (d.isAdmin && v.status === 'DRAFT') {
    const empty = d.participants.filter((p) => !p.filled).length;
    const blocked = !d.linesValidation.ok || empty > 0;
    actions.append(h('button', {
      class: 'btn btn-blue', disabled: blocked, onclick: async () => {
        try { await api('POST', `/api/deals/${d.id}/submit`); toast('Enviada para assinatura. Termos travados por hash.'); reload(); } catch (e) { toast(e.message, 'err'); }
      },
    }, 'ENVIAR PARA ASSINATURA'));
    if (!d.linesValidation.ok) notes.push(`Bloqueado: ${d.linesValidation.errors.join(' ')}`);
    if (empty > 0) notes.push(`Bloqueado: ${empty} função(ões) sem parceiro. Gere o convite na aba Participantes.`);
  }
  if (d.isAdmin && v.status === 'PENDING_SIGNATURES') {
    actions.append(h('button', {
      class: 'btn btn-ghost', onclick: async () => {
        try { const r = await api('POST', `/api/deals/${d.id}/reopen`); toast(`Voltou para rascunho. ${r.invalidated} assinatura(s) invalidada(s).`); reload(); } catch (e) { toast(e.message, 'err'); }
      },
    }, 'VOLTAR PARA RASCUNHO'));
    if (state.config?.demoMode) {
      actions.append(h('button', { class: 'btn btn-ghost', onclick: () => demoCollect(d) }, 'DEMO: assinar como personas pendentes'));
    }
  }
  if (d.isAdmin && v.status === 'LOCKED') {
    actions.append(h('button', {
      class: 'btn btn-ghost', onclick: async () => {
        try { const r = await api('POST', `/api/deals/${d.id}/new-version`); toast(`Versão ${r.versionNo} criada em rascunho. Novos aceites serão exigidos.`); reload(); } catch (e) { toast(e.message, 'err'); }
      },
    }, 'CRIAR NOVA VERSÃO'));
  }
  // Link de visualização: só o admin da mesa (Pay Master 01) pode gerar e compartilhar.
  if (d.isAdmin) {
    actions.append(h('button', { class: 'btn btn-ghost', onclick: () => openShareSheet(d) }, 'LINK DE VISUALIZAÇÃO'));
  }
  return h('div', {},
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', {}, 'Parceria'), h('span', { class: 'kn' }, d.signatures.label)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Estado'), h('dd', {}, STATUS_PT[v.status]),
        h('dt', {}, 'Versão'), h('dd', { class: 'mono' }, `v${v.no} de ${v.versionsCount}`),
        h('dt', {}, 'Hash dos termos'), h('dd', { class: 'hash' }, v.termsHash ?? 'gerado ao enviar para assinatura'),
        h('dt', {}, 'Política de resíduo'), h('dd', {}, POLICY_LABEL[v.residualPolicy]),
        v.lockedAt ? [h('dt', {}, 'Travada em'), h('dd', {}, fmtDate(v.lockedAt))] : null,
        h('dt', {}, 'Sua função'), h('dd', {}, d.me ? `${d.me.role} · ${d.me.signed ? '✓ assinado' : '○ pendente'}` : (d.isAdmin ? 'Admin' : '—'))),
      ['LOCKED', 'FUNDED', 'EXECUTING', 'SETTLED'].includes(v.status)
        ? h('p', { class: 'notice notice-info' }, 'PARTNERSHIP LOCKED: carteira, percentual, participante, ativo, valor e política de resíduo só mudam por NOVA VERSÃO, com novos aceites de todos.') : null,
      actions,
      notes.map((n) => h('p', { class: 'small muted', style: 'margin-top:8px' }, n))),
    h('div', { style: 'margin-top:14px' }, qualCard(d)));
}

/** DEMO: as personas pendentes assinam com as chaves DEMO deste aparelho; depois volta para a sessão original. */
async function demoCollect(d) {
  const ad = getAdapter();
  // Só o provider DEMO: as personas têm chaves derivadas de sementes públicas, que a carteira real
  // não possui. Com a extensão instalada, `ad.provider` pode ser ela — assinar por aqui falharia.
  const demo = ad.providers.find((p) => p.demo);
  if (!demo) { toast('Este atalho só existe com a carteira DEMO.', 'err'); return; }
  const accs = await demo.accounts();
  const pending = d.participants.filter((p) => p.filled && !p.signed && !p.isMe && accs.some((a) => a.address === p.wallet));
  if (!pending.length) { toast('Nenhuma persona DEMO pendente neste aparelho.', 'err'); return; }
  const original = state.me.wallet;
  const loginAs = async (addr) => {
    const acc = accs.find((a) => a.address === addr);
    await demo.connect(acc.key);
    const ch = await api('POST', '/auth/wallet-challenge', { address: addr });
    // A assinatura é AGUARDADA antes de entrar no corpo: mandar a Promise direta enviaria {}.
    const signature = await demo.signMessage(ch.message);
    await api('POST', '/auth/wallet-verify', { challengeId: ch.challengeId, nonce: ch.nonce, signature });
  };
  try {
    for (const p of pending) {
      await loginAs(p.wallet);
      const ch = await api('POST', `/api/deals/${d.id}/agreement/challenge`);
      const signature = await demo.signMessage(ch.message);
      await api('POST', `/api/deals/${d.id}/agreement/sign`, { challengeId: ch.challengeId, nonce: ch.nonce, signature });
    }
    toast(`${pending.length} persona(s) assinaram (DEMO).`);
  } catch (e) { toast(e.message, 'err'); }
  finally {
    try { await loginAs(original); state.me = await api('GET', '/api/me'); } catch { state.me = null; }
    reload();
  }
}

async function tabParticipantes(d) {
  const editable = d.isAdmin && d.version.status === 'DRAFT';
  let invites = [];
  let viewers = null;
  if (d.isAdmin) {
    invites = (await api('GET', `/invitations?dealId=${d.id}`)).invitations;
    // Quem abriu o link de visualização da mesa. É recurso OPCIONAL: existe na pré-visualização e
    // pode não existir no servidor. Rota ausente (404) não pode derrubar a aba inteira — sem ela o
    // admin ainda precisa chegar aqui para GERAR CONVITE, que é o caminho principal da mesa.
    viewers = await api('GET', `/api/deals/${d.id}/viewers`).catch((e) => { if (e.status === 404) return null; throw e; });
  }
  const rows = d.participants.map((p) => {
    const live = invites.find((i) => i.roleKey === p.roleKey && i.roleSeq === p.seq && (i.status === 'ATIVO' || i.status === 'ABERTO'));
    const acts = [];
    if (editable && !p.filled && !live) acts.push(h('button', { class: 'btn btn-primary btn-sm', onclick: () => openInviteSheet(d, p, reload) }, 'GERAR CONVITE'));
    if (d.isAdmin && live) {
      acts.push(h('button', { class: 'btn btn-danger btn-sm', onclick: async () => { try { await api('POST', `/invitations/${live.id}/revoke`); toast('Convite revogado.'); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'REVOGAR'));
      acts.push(h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { const r = await api('POST', `/invitations/${live.id}/regenerate`); showInviteResult(r); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'GERAR NOVO LINK'));
    }
    if (editable && p.filled && !(p.roleKey === 'PAY_MASTER' && p.seq === 1)) {
      acts.push(h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { await api('POST', `/api/deals/${d.id}/slots/${p.id}/vacate`); toast('Cadeira liberada para novo convite.'); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'LIBERAR CADEIRA'));
    }
    if (editable && !p.filled && !live && !(p.roleKey === 'PAY_MASTER' && p.seq === 1)) {
      acts.push(h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { await api('DELETE', `/api/deals/${d.id}/slots/${p.id}`); toast('Função removida.'); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'REMOVER FUNÇÃO'));
    }
    return h('div', {},
      h('div', { class: 'row' },
        h('div', {}, p.payMasterBadge ? h('span', { class: 'chip chip-seal', style: 'margin-right:8px' }, p.payMasterBadge) : null, h('b', {}, p.role)),
        h('span', { class: 'mono' }, p.bpsLabel)),
      h('div', { class: 'small muted', style: 'margin-top:4px' },
        p.filled ? `${p.name} · ${short(p.wallet)} · ${p.signed ? '✓ assinado' : '○ pendente'}` : (live ? `Convite ${INVITE_STATUS[live.status]} · expira ${fmtDate(live.expiresAt)}` : 'Cadeira vazia')),
      p.filled && p.contactVisible ? h('div', { class: 'small', style: 'margin-top:2px' }, `${p.phone} · ${p.email}`) : null,
      acts.length ? h('div', { class: 'btn-row', style: 'margin-top:10px' }, acts) : null);
  });
  const addSel = h('select', { 'aria-label': 'Função a adicionar' }, Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k }, l)));
  return h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Participantes da versão atual'), h('div', { class: 'list' }, rows)),
    editable ? h('section', { class: 'panel' }, h('h2', {}, 'Adicionar função'),
      h('div', { class: 'btn-row' }, addSel, h('button', {
        class: 'btn btn-blue', onclick: async () => { try { await api('POST', `/api/deals/${d.id}/slots`, { roleKey: addSel.value }); toast('Função adicionada.'); reload(); } catch (e) { toast(e.message, 'err'); } },
      }, 'ADICIONAR'))) : null,
    !editable && d.isAdmin ? h('p', { class: 'notice notice-info', style: 'margin-top:14px' }, 'Convites e mudanças de participantes só em DRAFT. Em parceria travada, crie uma NOVA VERSÃO.') : null,
    d.isAdmin && invites.length ? h('section', { class: 'panel' }, h('h2', {}, 'Convites desta operação'),
      h('div', { class: 'list' }, invites.map((i) => h('div', { class: 'row small' },
        h('span', {}, `${i.role} · v${i.versionNo} · ${i.bpsLabel}`),
        h('span', { class: 'muted' }, `${INVITE_STATUS[i.status]} · ${fmtDate(i.createdAt)}`))))) : null,
    viewers ? viewersPanel(d, viewers) : null);
}

/** Quem abriu o link de visualização, com os dados que a própria pessoa informou. Só o admin vê. */
function viewersPanel(d, { hasLink, viewers }) {
  return h('section', { class: 'panel' },
    h('div', { class: 'section-title', style: 'margin-top:0' },
      h('h2', {}, 'Acessos pelo link de visualização'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openShareSheet(d) }, 'LINK'))),
    viewers.length
      ? h('div', { class: 'stack' }, viewers.map((v) => h('div', { class: 'panel', style: 'margin:0' },
        h('div', { class: 'row' },
          h('div', {}, h('b', {}, v.name), v.isParticipant ? h('span', { class: 'chip chip-ok', style: 'margin-left:8px' }, 'TAMBÉM PARTICIPANTE') : null),
          h('span', { class: 'mono small' }, v.walletShort)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'E-mail'), h('dd', {}, v.email),
          h('dt', {}, 'Telefone'), h('dd', {}, v.phone),
          h('dt', {}, 'País'), h('dd', {}, v.countryLabel),
          h('dt', {}, 'Carteira'), h('dd', { class: 'mono small' }, v.wallet),
          h('dt', {}, 'Abriu em'), h('dd', {}, fmtDate(v.at))))))
      : h('p', { class: 'muted small' }, hasLink
        ? 'Ninguém abriu o link ainda. Quem abrir precisa informar nome, e-mail e telefone, e conectar a Verum Wallet — os dados aparecem aqui.'
        : 'Esta mesa ainda não tem link de visualização. Gere um para acompanhar quem abre a operação.'),
    viewers.length ? h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Dados informados por quem abriu o link. A carteira é verificada por assinatura; os contatos não são verificados pela mesa.') : null);
}

function chainDiagram(d) {
  const order = ['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'PAY_MASTER', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR'];
  const nodes = [...d.participants].sort((a, b) => (order.indexOf(a.roleKey) - order.indexOf(b.roleKey)) || (a.seq - b.seq));
  const out = [];
  nodes.forEach((p, i) => {
    if (i > 0) out.push(h('div', { class: 'chain-link', 'aria-hidden': 'true' }));
    out.push(h('div', { class: `chain-node ${p.isPayMaster ? 'pm' : ''}` },
      h('b', {}, p.payMasterBadge ? `${p.payMasterBadge} · ${p.role}` : p.role), h('span', { class: 'mono' }, p.bpsLabel),
      h('span', { class: 'small muted' }, p.name ?? 'Aguardando convite'), h('span', { class: 'small mono muted' }, `${short(p.wallet)} · ${p.signed ? '✓' : '○'}`)));
  });
  return h('div', { class: 'chain', 'aria-label': 'Cadeia comercial da venda para a compra' }, out);
}

function tabEstrutura(d) {
  const page = h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Estrutura comercial'), h('p', { class: 'small muted', style: 'margin-bottom:12px' }, 'Vendedor → Grupo Venda → Intermediação Venda → Pay Master / Ligação → Intermediação Compra → Grupo Compra → Comprador'), chainDiagram(d)),
    h('section', { class: 'panel' }, h('h2', {}, `Comissões — grade ${d.offer.grade.label}`), commissionTable(d.lines, d.offer.grade.totalBps)));
  if (d.isAdmin) page.append(lineEditor(d));
  return page;
}

/** Editor de linhas (bps inteiros). Em DRAFT salva; fora de DRAFT o backend recusa e a tela mostra o bloqueio. */
function lineEditor(d) {
  const locked = d.version.status !== 'DRAFT';
  const slots = d.participants.map((p) => [`${p.roleKey}#${p.seq}`, p.role]);
  let lines = d.lines.map((l) => ({ ...l }));
  let policy = d.version.residualPolicy;
  const panel = h('section', { class: 'panel' });
  const draw = () => {
    clear(panel);
    const sum = lines.reduce((a, l) => a + (Number.isInteger(l.bps) ? l.bps : 0), 0);
    const ok = sum === d.version.gradeTotalBps && lines.every((l) => Number.isInteger(l.bps));
    add(panel,
      h('h2', {}, locked ? 'Alterar percentuais (parceria travada)' : 'Editar comissões (DRAFT)'),
      locked ? h('p', { class: 'notice notice-risk', style: 'margin-bottom:12px' }, 'Esta versão não está em DRAFT. Qualquer alteração será recusada pelo servidor e pelo banco — use CRIAR NOVA VERSÃO.') : null,
      lines.map((l, i) => h('div', { class: 'editor-line' },
        h('input', { value: l.label, 'aria-label': 'Rótulo da linha', maxlength: '60', oninput: (e) => { l.label = e.target.value; } }),
        h('input', {
          class: 'mono', value: bpsToPct(l.bps), inputmode: 'decimal', 'aria-label': 'Percentual (até 2 casas)',
          onchange: (e) => { const b = pctToBps(e.target.value); if (b === null) { toast('Percentual inválido (até 2 casas decimais).', 'err'); e.target.value = bpsToPct(l.bps); return; } l.bps = b; setTimeout(draw, 0); }, // redesenha depois do blur, sem engolir o clique seguinte
        }),
        h('div', { class: 'sub' },
          h('select', { 'aria-label': 'Beneficiário', onchange: (e) => { const [k, s] = e.target.value.split('#'); l.roleKey = k; l.roleSeq = Number(s); } },
            slots.map(([v, lab]) => h('option', { value: v, selected: v === `${l.roleKey}#${l.roleSeq}` }, lab))),
          h('select', { 'aria-label': 'Tipo', onchange: (e) => { l.kind = e.target.value; } }, Object.entries(KIND_LABEL).map(([k, lab]) => h('option', { value: k, selected: k === l.kind }, lab))),
          h('button', { class: 'icon-btn', 'aria-label': 'Remover linha', onclick: () => { lines.splice(i, 1); draw(); } }, '×')))),
      h('button', {
        class: 'btn btn-ghost btn-sm', style: 'margin-top:10px', onclick: () => {
          const first = d.participants[0];
          lines.push({ lineKey: `linha_${Date.now().toString(36)}`, label: 'Nova linha', roleKey: first.roleKey, roleSeq: first.seq, bps: 0, kind: 'COMISSAO' }); draw();
        },
      }, icon('plus'), 'Adicionar linha'),
      h('div', { class: `sumbar ${ok ? 'ok' : 'bad'}` }, h('span', {}, 'Soma das linhas'), h('span', {}, `${bpsToPct(sum)}% / ${bpsToPct(d.version.gradeTotalBps)}% ${ok ? '✓' : '✗ não fecha'}`)),
      h('label', { class: 'field' }, h('span', {}, 'Política de resíduo'),
        h('select', { onchange: (e) => { policy = e.target.value; } }, Object.entries(POLICY_LABEL).map(([k, lab]) => h('option', { value: k, selected: k === policy }, lab)))),
      h('button', {
        class: 'btn btn-blue btn-block', onclick: async () => {
          try {
            const payload = lines.map((l) => ({ lineKey: l.lineKey, label: l.label, roleKey: l.roleKey, roleSeq: l.roleSeq ?? 1, bps: l.bps, kind: l.kind }));
            const r = await api('PUT', `/api/deals/${d.id}/lines`, { lines: payload, residualPolicy: policy });
            toast(r.validation.ok ? 'Comissões salvas. Soma fecha com a grade.' : 'Salvo em rascunho, mas a soma ainda não fecha: não pode ir para assinatura.', r.validation.ok ? 'ok' : 'err');
            reload();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, 'SALVAR COMISSÕES'));
  };
  draw();
  return panel;
}

async function tabDocumentos(d) {
  const { documents } = await api('GET', `${dealBase(d)}/documents`);
  const panel = h('section', { class: 'panel' }, h('h2', {}, 'Documentos'),
    documents.length ? h('div', { class: 'list' }, documents.map((doc) => h('div', {},
      h('div', { class: 'row' }, h('b', {}, `${doc.name} · v${doc.versionNo}`), h('span', { class: 'chip chip-status' }, doc.status)),
      h('div', { class: 'hash', style: 'margin-top:4px' }, `SHA-256 ${doc.sha256}`),
      h('div', { class: 'small muted' }, `${fmtDate(doc.createdAt)} · ${Math.ceil(doc.size / 1024)} KB · aceito por: ${doc.acceptedBy.length ? doc.acceptedBy.map((a) => a.name).join(', ') : 'ninguém ainda'}`),
      h('div', { class: 'btn-row', style: 'margin-top:8px' },
        // downloadUrl só existe na pré-visualização (data: URI, sem servidor). No servidor real o
        // conteúdo vem por rota, e dealBase mantém o link certo também para quem abriu por link.
        h('a', { class: 'btn btn-ghost btn-sm', href: doc.downloadUrl || `${dealBase(d)}/documents/${doc.versionId}/content` }, 'BAIXAR'),
        !d.readOnly && doc.isLatest && doc.requiresAcceptance && !doc.iAccepted ? h('button', {
          class: 'btn btn-primary btn-sm', onclick: async () => {
            try { await signFlow(`/api/deals/${d.id}/documents/${doc.versionId}/challenge`, `/api/deals/${d.id}/documents/${doc.versionId}/accept`, { title: 'Aceitar documento', action: 'ACEITAR' }); toast('Aceite registrado.'); reload(); }
            catch (e) { if (e.code !== 'CANCELLED') toast(e.message, 'err'); }
          },
        }, 'ACEITAR (ASSINAR)') : null,
        doc.iAccepted ? h('span', { class: 'chip chip-ok' }, '✓ você aceitou') : null))))
      : h('p', { class: 'muted small' }, 'Nenhum documento.'));
  const page = h('div', {}, panel);
  if (d.isAdmin) {
    const latest = new Map(); for (const doc of documents) if (doc.isLatest) latest.set(doc.documentId, doc.name);
    const file = h('input', { type: 'file', accept: '.pdf,.txt,.png,.jpg,.jpeg' });
    const name = h('input', { placeholder: 'Nome do documento', maxlength: '120' });
    const target = h('select', {}, h('option', { value: '' }, 'Documento novo'), [...latest.entries()].map(([id, n]) => h('option', { value: id }, `Nova versão de: ${n}`)));
    const req = h('input', { type: 'checkbox', checked: true, style: 'width:22px;height:22px;min-height:22px' });
    page.append(h('section', { class: 'panel' }, h('h2', {}, 'Adicionar documento'),
      h('label', { class: 'field' }, h('span', {}, 'Destino'), target),
      h('label', { class: 'field' }, h('span', {}, 'Nome'), name),
      h('label', { class: 'field' }, h('span', {}, 'Arquivo (PDF, TXT, PNG ou JPG, até 2 MB)'), file),
      h('label', { style: 'display:flex;gap:10px;align-items:center;min-height:44px;margin-bottom:12px' }, req, h('span', {}, 'Exige aceite dos participantes')),
      h('button', {
        class: 'btn btn-blue btn-block', onclick: async () => {
          const f = file.files?.[0];
          if (!f) { toast('Escolha um arquivo.', 'err'); return; }
          if (f.size > 2 * 1024 * 1024) { toast('Arquivo acima de 2 MB.', 'err'); return; }
          const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
          const mime = f.type || (f.name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream');
          const body = { mime, contentBase64: b64, requiresAcceptance: req.checked };
          if (target.value) body.documentId = target.value; else body.name = name.value.trim() || f.name;
          try { const r = await api('POST', `/api/deals/${d.id}/documents`, body); toast(`Documento v${r.versionNo} registrado. Hash ${r.sha256.slice(0, 12)}…`); reload(); } catch (e) { toast(e.message, 'err'); }
        },
      }, 'REGISTRAR DOCUMENTO'),
      h('p', { class: 'small muted', style: 'margin-top:10px' }, 'Documento alterado vira nova versão e exige novo aceite. Nada é sobrescrito.')));
  }
  return page;
}

async function tabCompliance(d) {
  const c = await api('GET', `${dealBase(d)}/compliance`);
  return h('div', {},
    h('p', { class: 'notice notice-info', style: 'margin-bottom:14px' }, c.notice),
    h('section', { class: 'panel' }, h('h2', {}, 'Status por participante'),
      h('div', { class: 'list' }, c.items.map((i) => h('div', {},
        h('div', { class: 'row' }, h('b', {}, i.role), h('span', { class: 'small muted' }, i.name ?? 'Cadeira vazia')),
        h('div', { class: 'chips', style: 'margin-top:6px' }, i.statuses.map((s) => h('span', { class: 'chip chip-status' }, s))))))),
    d.honestyNotice ? h('p', { class: 'notice notice-risk', style: 'margin-top:14px' }, d.honestyNotice) : null);
}

async function tabHistorico(d) {
  const { events } = await api('GET', `${dealBase(d)}/history`);
  return h('section', { class: 'panel' }, h('h2', {}, 'Trilha de auditoria'),
    h('p', { class: 'small muted', style: 'margin-bottom:8px' }, 'Registro somente-inclusão. Sem token de convite e sem dados de contato.'),
    h('div', { class: 'list' }, events.map((e) => h('div', {},
      h('div', { class: 'row' }, h('b', { class: 'small' }, ACTION_PT[e.action] ?? e.action), h('span', { class: 'small muted' }, fmtDate(e.at))),
      h('div', { class: 'small muted' }, `${e.actor}${e.walletShort ? ' · ' + e.walletShort : ''} · ${e.entity}`)))));
}

async function tabSettlement(d) {
  const v = d.version;
  const page = h('div', {},
    h('p', { class: 'notice notice-info', style: 'margin-bottom:14px' },
      d.settlementAdapter.demo
        ? 'Settlement SIMULADO (DEMO): nenhum fundo real se move. Não há contrato de escrow implantado, por isso nenhum selo de proteção é exibido.'
        : 'Settlement real.'));
  let preview = null;
  try { preview = d.settlement ? null : await api('GET', `${dealBase(d)}/settlement/preview`); } catch (e) { page.append(h('p', { class: 'notice' }, e.message)); }
  const st = d.settlement;
  const lines = st ? st.lines : preview?.lines;
  if (lines) {
    page.append(h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', {}, st ? `Distribuição — ${st.status}` : 'Prévia da distribuição'), st ? h('span', { class: 'chip chip-ok' }, st.status) : null),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Valor de referência'), h('dd', { class: 'mono' }, st ? st.referenceLabel : preview.referenceLabel),
        h('dt', {}, 'Total distribuído'), h('dd', { class: 'mono' }, st ? st.poolLabel : preview.poolLabel),
        h('dt', {}, 'Resíduo em unidades mínimas'), h('dd', { class: 'mono' }, st ? st.residualLabel : preview.residualLabel)),
      h('table', { class: 'comm' }, h('tbody', {}, lines.map((l) => h('tr', { class: l.kind === 'RESIDUO' ? 'residual' : '' },
        h('td', {}, l.label, h('div', { class: 'small muted' }, `${l.role ?? ''}${l.bps ? ' · ' + l.bpsLabel : ''}`)),
        h('td', {}, l.amountLabel))))),
      (st ? st.truncatedLabel : (preview.truncatedNumerator > 0 ? `${preview.truncatedNumerator}/10000 da unidade mínima (abaixo da menor unidade do ativo — não distribuível)` : null))
        ? h('p', { class: 'small muted', style: 'margin-top:8px' }, `Fração truncada: ${st ? st.truncatedLabel : `${preview.truncatedNumerator}/10000 da unidade mínima (abaixo da menor unidade do ativo — não distribuível)`}`) : null));
  }
  if (d.isAdmin && v.status === 'LOCKED') {
    page.append(h('section', { class: 'panel' }, h('h2', {}, 'AUTORIZAR LIQUIDAÇÃO'),
      h('p', { class: 'small', style: 'margin-bottom:12px' }, 'Você vai autorizar a distribuição exata acima, por bps travados, com o resíduo indicado. No DEMO a liquidação é simulada e nenhum fundo é movimentado. É uma etapa separada da assinatura da parceria.'),
      h('button', {
        class: 'btn btn-primary btn-block', onclick: async () => {
          try { await signFlow(`/api/deals/${d.id}/settlement/challenge`, `/api/deals/${d.id}/settlement/fund`, { title: 'AUTORIZAR LIQUIDAÇÃO', action: 'AUTORIZAR' }); toast('Liquidação autorizada (FUNDED, simulação).'); reload(); }
          catch (e) { if (e.code !== 'CANCELLED') toast(e.message, 'err'); }
        },
      }, 'AUTORIZAR LIQUIDAÇÃO')));
  }
  if (d.isAdmin && v.status === 'FUNDED') {
    page.append(h('section', { class: 'panel' }, h('h2', {}, 'Executar distribuição'),
      h('button', {
        class: 'btn btn-primary btn-block', onclick: async () => {
          try { await api('POST', `/api/deals/${d.id}/settlement/execute`); toast('SETTLED. Distribuição registrada na auditoria.'); reload(); } catch (e) { toast(e.message, 'err'); }
        },
      }, 'EXECUTAR DISTRIBUIÇÃO (SIMULADA)')));
  }
  if (!['LOCKED', 'FUNDED', 'EXECUTING', 'SETTLED'].includes(v.status)) page.append(h('p', { class: 'small muted' }, 'A liquidação só fica disponível depois da PARTNERSHIP LOCKED.'));
  return page;
}

// ================================================================= nova oferta
// Modelos de OTC de cripto. Só preenchem as pernas da oferta a partir do registro de ativos:
// não criam estado novo — a modalidade já fica registrada nas pernas (ativo + legType) da mesa.
const OTC_PRESETS = [
  { id: '', label: 'Personalizado' },
  { id: 'VENDA_FIAT', label: 'Venda de cripto → Fiat (PIX/transferência)', deliver: ['USDT', 'ONCHAIN'], receive: ['BRL', 'FIAT_TRANSFER'], title: 'USDT contra BRL — transferência' },
  { id: 'VENDA_ESPECIE', label: 'Venda de cripto → Espécie (USD cash)', deliver: ['USDT', 'ONCHAIN'], receive: ['USD', 'CASH_PHYSICAL'], title: 'USDT contra USD em espécie' },
  { id: 'COMPRA_FIAT', label: 'Compra de cripto ← Fiat (PIX/transferência)', deliver: ['BRL', 'FIAT_TRANSFER'], receive: ['USDT', 'ONCHAIN'], title: 'BRL contra USDT' },
  { id: 'COMPRA_ESPECIE', label: 'Compra de cripto ← Espécie (USD cash)', deliver: ['USD', 'CASH_PHYSICAL'], receive: ['USDT', 'ONCHAIN'], title: 'USD em espécie contra USDT' },
  { id: 'SWAP_BTC', label: 'Troca cripto → cripto (BTC contra USDT)', deliver: ['BTC', 'ONCHAIN'], receive: ['USDT', 'ONCHAIN'], title: 'BTC contra USDT — lote' },
  { id: 'SWAP_SOL', label: 'Troca cripto → cripto (SOL contra USDC)', deliver: ['SOL', 'ONCHAIN'], receive: ['USDC', 'ONCHAIN'], title: 'SOL contra USDC — lote' },
  { id: 'CRIPTO_FISICO', label: 'Cripto → Ativo físico', deliver: ['USDT', 'ONCHAIN'], receive: ['ATIVO FÍSICO', 'PHYSICAL_ASSET'], title: 'USDT contra ativo físico' },
  { id: 'FISICO_CRIPTO', label: 'Ativo físico → Cripto', deliver: ['ATIVO FÍSICO', 'PHYSICAL_ASSET'], receive: ['USDT', 'ONCHAIN'], title: 'Ativo físico contra USDT' },
];

async function newOfferPage() {
  const [{ assets }, { businesses }] = await Promise.all([api('GET', '/api/assets'), api('GET', '/api/businesses')]);
  const sel = assets.filter((a) => a.selectable);
  const onchain = sel.filter((a) => a.legType === 'ONCHAIN');
  const f = {
    kind: h('select', {}, h('option', { value: 'UNICA' }, 'OFERTA ÚNICA'), h('option', { value: 'PERMANENTE' }, 'PARCERIA PERMANENTE')),
    business: h('select', {}, h('option', { value: '' }, 'Novo Negócio'), businesses.map((b) => h('option', { value: b.id }, b.name))),
    businessName: h('input', { maxlength: '80', placeholder: 'Nome do Negócio' }),
    title: h('input', { maxlength: '80', required: true, placeholder: 'Ex.: BTC contra USDT — lote diário' }),
    deliver: h('select', {}, sel.map((a) => h('option', { value: a.id }, `${a.symbol} — ${a.name}`))),
    deliverDesc: h('input', { maxlength: '80', placeholder: 'Descrição (para ativo físico)' }),
    receive: h('select', {}, sel.map((a, i) => h('option', { value: a.id, selected: a.symbol === 'USDT' && i > 0 }, `${a.symbol} — ${a.name}`))),
    volume: h('input', { maxlength: '80', required: true, placeholder: 'Ex.: 10 unidades / mínimo diário 350 BTC' }),
    refAmount: h('input', { inputmode: 'decimal', placeholder: 'Ex.: 1.000.000,00 (opcional)' }),
    refAsset: h('select', {}, onchain.map((a) => h('option', { value: a.id, selected: a.symbol === 'USDT' }, a.symbol))),
    grade: h('input', { class: 'mono', placeholder: 'X/Y — ex.: 25/15', required: true }),
    conditions: h('textarea', { placeholder: 'Até 5 linhas curtas: procedimento, tranche, mínimo diário, o que não operamos…' }),
    pms: h('select', {}, h('option', { value: '1' }, '1 Pay Master'), h('option', { value: '2' }, '2 Pay Masters')),
    preset: h('select', {}, OTC_PRESETS.map((p) => h('option', { value: p.id }, p.label))),
  };
  const roleBoxes = ['VENDEDOR', 'GRUPO_VENDA', 'INTERMEDIACAO_VENDA', 'INTERMEDIACAO_COMPRA', 'GRUPO_COMPRA', 'COMPRADOR'].map((k) => {
    const cb = h('input', { type: 'checkbox', checked: true, value: k, style: 'width:22px;height:22px;min-height:22px' });
    return { cb, el: h('label', { style: 'display:flex;gap:10px;align-items:center;min-height:44px' }, cb, ROLE_LABEL[k]) };
  });
  const bizBox = h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Negócio'), f.business), h('label', { class: 'field' }, h('span', {}, 'Nome do novo Negócio'), f.businessName),
    h('p', { class: 'small muted', style: 'margin:-6px 0 14px' }, 'Ofertas de um Negócio existente herdam parceiros, papéis e linhas da última versão travada.'));
  const toggle = () => { bizBox.style.display = f.kind.value === 'PERMANENTE' ? '' : 'none'; f.businessName.parentElement.style.display = f.business.value ? 'none' : ''; };
  f.kind.addEventListener('change', toggle); f.business.addEventListener('change', toggle);

  // Aplica o modelo escolhido. Só mexe no título se ele estiver vazio ou ainda for o texto
  // que um modelo colocou — o que você digitou nunca é sobrescrito.
  const presetNote = h('p', { class: 'small muted', style: 'margin:-6px 0 14px' });
  const bySym = (symbol, legType) => sel.find((a) => a.symbol === symbol && a.legType === legType);
  let autoTitle = '';
  const applyPreset = () => {
    const p = OTC_PRESETS.find((x) => x.id === f.preset.value);
    if (!p || !p.deliver) { presetNote.textContent = 'Escolha um modelo para preencher as pernas, ou monte a oferta campo a campo.'; return; }
    const dl = bySym(...p.deliver), rc = bySym(...p.receive);
    if (!dl || !rc) { presetNote.textContent = 'Este modelo usa um ativo que não está no registro desta instalação. Ajuste as pernas à mão.'; return; }
    f.deliver.value = dl.id; f.receive.value = rc.id;
    const ref = [dl, rc].find((a) => a.legType === 'ONCHAIN');
    if (ref && [...f.refAsset.options].some((o) => o.value === ref.id)) f.refAsset.value = ref.id;
    const t = f.title.value.trim();
    if (!t || t === autoTitle) { f.title.value = p.title; autoTitle = p.title; }
    const off = [dl, rc].filter((a) => a.legType !== 'ONCHAIN');
    presetNote.textContent = off.length
      ? `${dl.symbol} → ${rc.symbol}. Perna fora da plataforma (${off.map((a) => a.name).join(', ')}): recebe o aviso de honestidade e não é protegida por contrato.`
      : `${dl.symbol} → ${rc.symbol}. As duas pernas são on-chain.`;
  };
  f.preset.addEventListener('change', applyPreset);
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = async (e) => {
    e.preventDefault(); err.textContent = '';
    const conditions = f.conditions.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (conditions.length > 5) { err.textContent = 'Condições: no máximo 5 linhas.'; return; }
    const body = {
      kind: f.kind.value, title: f.title.value.trim(), deliverAssetId: f.deliver.value, receiveAssetId: f.receive.value,
      volumeText: f.volume.value.trim(), grade: f.grade.value.trim(), conditions, payMasters: Number(f.pms.value),
      roles: roleBoxes.filter((r) => r.cb.checked).map((r) => r.cb.value),
    };
    if (f.deliverDesc.value.trim()) body.deliverDescription = f.deliverDesc.value.trim();
    if (f.refAmount.value.trim()) { body.referenceAmount = f.refAmount.value.trim(); body.referenceAssetId = f.refAsset.value; }
    if (f.kind.value === 'PERMANENTE') { if (f.business.value) body.businessId = f.business.value; else body.businessName = f.businessName.value.trim(); }
    try { const r = await api('POST', '/api/deals', body); toast(`Oferta ${r.code} criada em rascunho.`); location.hash = `#/deal/${r.dealId}/room/participantes`; }
    catch (x) { err.textContent = x.message; }
  };
  const form = h('form', { class: 'panel', onsubmit: submit },
    h('label', { class: 'field' }, h('span', {}, 'Tipo'), f.kind), bizBox,
    presetNote,
    h('label', { class: 'field' }, h('span', {}, 'Título'), f.title),
    h('label', { class: 'field' }, h('span', {}, 'Ativo ofertado (entrega)'), f.deliver),
    h('label', { class: 'field' }, h('span', {}, 'Descrição da entrega (opcional)'), f.deliverDesc),
    h('label', { class: 'field' }, h('span', {}, 'Ativo recebido'), f.receive),
    h('label', { class: 'field' }, h('span', {}, 'Volume'), f.volume),
    h('div', { style: 'display:grid;grid-template-columns:1fr 110px;gap:10px' },
      h('label', { class: 'field' }, h('span', {}, 'Valor de referência'), f.refAmount), h('label', { class: 'field' }, h('span', {}, 'Ativo'), f.refAsset)),
    h('label', { class: 'field' }, h('span', {}, 'Grade (deságio total / parte do Pagador)'), f.grade),
    h('label', { class: 'field' }, h('span', {}, 'Condições (texto livre, até 5 linhas)'), f.conditions),
    h('fieldset', { style: 'border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px' },
      h('legend', { class: 'small muted' }, 'Funções da cadeia (o Pay Master / Ligação é sempre você)'), roleBoxes.map((r) => r.el),
      h('label', { class: 'field', style: 'margin-top:8px' }, h('span', {}, 'Pay Masters'), f.pms)),
    h('p', { class: 'small muted', style: 'margin-bottom:12px' }, 'Pernas fora da plataforma (espécie, fiat, ativo físico) recebem o aviso de honestidade automaticamente. Local e data entram só como texto em Condições.'),
    err, h('button', { class: 'btn btn-primary btn-block' }, 'CRIAR OFERTA EM RASCUNHO'));
  setTimeout(() => { toggle(); applyPreset(); }, 0);
  return h('div', {}, back('#/home', 'Mesas'),
    h('div', { class: 'section-title', style: 'margin-top:0;margin-bottom:14px;align-items:flex-end;gap:16px;flex-wrap:wrap' },
      h('h1', {}, 'Nova oferta'),
      h('label', { class: 'field', style: 'margin:0;flex:1 1 240px;max-width:380px' }, h('span', {}, 'Modelo de OTC de cripto'), f.preset)),
    form);
}

// ================================================================= convites (admin)
async function invitesPage() {
  const { invitations } = await api('GET', '/invitations');
  return h('div', {}, pageHead('Convites'),
    h('p', { class: 'small muted', style: 'margin-bottom:14px' }, 'Convites são gerados na aba Participantes de cada Deal Room. Link e código aparecem uma única vez.'),
    invitations.length ? h('div', { class: 'panel list' }, invitations.map((i) => h('div', {},
      h('div', { class: 'row' }, h('b', {}, `${i.dealCode} · ${i.role}`), h('span', { class: 'chip chip-status' }, INVITE_STATUS[i.status])),
      h('div', { class: 'small muted', style: 'margin-top:4px' },
        `${i.title} · ${i.bpsLabel} · criado ${fmtDate(i.createdAt)}${i.openedAt ? ' · aberto ' + fmtDate(i.openedAt) : ''}${i.completedAt ? ' · concluído ' + fmtDate(i.completedAt) : ''}`),
      h('div', { class: 'btn-row', style: 'margin-top:8px' },
        i.canRevoke ? h('button', { class: 'btn btn-danger btn-sm', onclick: async () => { try { await api('POST', `/invitations/${i.id}/revoke`); toast('Convite revogado.'); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'REVOGAR') : null,
        i.canRegenerate ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { try { const r = await api('POST', `/invitations/${i.id}/regenerate`); showInviteResult(r); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'GERAR NOVO LINK') : null,
        h('a', { class: 'btn btn-ghost btn-sm', href: `#/deal/${i.dealId}/room/participantes` }, 'Deal Room')))))
      : h('div', { class: 'empty-state' }, 'Nenhum convite gerado.'));
}

async function pickDealPage(tab, title, hint) {
  const { deals } = await api('GET', '/api/deals');
  return h('div', {}, pageHead(title), h('p', { class: 'small muted', style: 'margin-bottom:14px' }, hint),
    h('div', { class: 'panel list' }, deals.map((d) => h('div', { class: 'row' },
      h('div', {}, h('b', {}, d.offer.businessName ? `${d.offer.businessName} — ${d.offer.title}` : d.offer.title), h('div', { class: 'small muted' }, `${d.code} · ${STATUS_PT[d.version.status]}${d.settlementStatus ? ' · settlement ' + d.settlementStatus : ''}`)),
      h('a', { class: 'btn btn-ghost btn-sm', href: `#/deal/${d.id}/room/${tab}` }, 'Abrir')))));
}

async function auditPage() {
  const { events } = await api('GET', '/api/audit');
  return h('div', {}, pageHead('Auditoria'),
    h('p', { class: 'small muted', style: 'margin-bottom:14px' }, 'Eventos das operações que você administra. Somente inclusão; sem token de convite e sem dados de contato.'),
    events.length ? h('div', { class: 'panel list' }, events.map((e) => h('div', { class: 'row small' },
      h('span', {}, h('span', { class: 'mono' }, e.dealCode), ' · ', ACTION_PT[e.action] ?? e.action, e.wallet ? h('span', { class: 'mono muted' }, ` · ${e.wallet}`) : null),
      h('span', { class: 'muted' }, fmtDate(e.at))))) : h('div', { class: 'empty-state' }, 'Sem eventos.'));
}

// ================================================================= carteira e perfil
function walletPage() {
  const ad = getAdapter();
  const me = state.me;
  return h('div', {}, pageHead('Carteira'),
    h('section', { class: 'panel' },
      h('h2', {}, 'Verum Wallet conectada'),
      h('div', { class: 'qrbox' }, qrSvg(me.wallet)),
      h('div', { class: 'hash', style: 'text-align:center;margin-bottom:12px' }, me.wallet),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ghost', onclick: () => copy(me.wallet, 'Endereço copiado') }, 'Copiar endereço')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Provider'), h('dd', {}, ad.provider?.label ?? 'Indisponível'),
        h('dt', {}, 'Rede'), h('dd', { class: 'mono' }, state.config?.network ?? '—'),
        h('dt', {}, 'Mainnet'), h('dd', {}, 'Desligada'))),
    h('p', { class: 'notice notice-info', style: 'margin-top:14px' },
      'A exigência da Verum Wallet é aplicada neste aparelho. O servidor verifica a assinatura com a sua chave pública, mas não consegue identificar qual software a gerou — por isso a mesa não afirma que a autocustódia foi "verificada".'),
    h('p', { class: 'small muted', style: 'margin-top:12px' }, 'A Verum nunca guarda fundos, seed, chave privada ou senha.'),
    walletDiagnostico(ad));
}

/**
 * O que este aparelho enxerga. Existe porque "carteira não encontrada" não diz nada a quem tem a
 * extensão instalada: aqui aparece o que foi detectado, o que foi recusado e por quê — é com isto
 * que se descobre o formato de uma extensão nova, em vez de adivinhar a API dela.
 */
function walletDiagnostico(ad) {
  const linha = (rotulo, valor, classe) => h('div', { class: 'row small' }, h('span', { class: 'muted' }, rotulo), h('span', { class: classe || '' }, valor));
  return h('details', { class: 'panel', style: 'margin-top:14px' },
    h('summary', { class: 'small muted' }, 'Diagnóstico da carteira'),
    h('div', { style: 'margin-top:10px' },
      linha('Carteiras aceitas', ad.providers.length ? ad.providers.map((p) => p.label ?? 'Verum Wallet').join(' · ') : 'nenhuma'),
      linha('Ativa agora', ad.provider ? `${ad.provider.label ?? 'Verum Wallet'}${ad.provider.demo ? ' (simulada)' : ''}` : '—'),
      ad.reason ? linha('Motivo', ad.reason, 'muted') : null,
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('h2', { style: 'font-size:13px' }, 'O que foi encontrado no navegador')),
      (ad.probe ?? []).length
        ? h('div', { class: 'list' }, ad.probe.map((x) => h('div', {},
          h('div', { class: 'row small' }, h('span', { class: 'mono' }, x.onde), h('span', { class: `chip ${x.aceito ? 'chip-ok' : 'chip-status'}` }, x.aceito ? 'aceita' : 'recusada')),
          x.motivo ? h('div', { class: 'small muted' }, x.motivo) : null,
          x.metodos?.length ? h('div', { class: 'hash', style: 'margin-top:4px' }, x.metodos.join(', ')) : null)))
        : h('p', { class: 'small muted' }, 'Nenhum provider de carteira nesta página.'),
      // Como a conexão acontece de verdade: a Verum Wallet é um PWA que abre as plataformas
      // parceiras dentro de um iframe dela. Quem cria o provider é o conector embarcado AQUI,
      // conversando com a wallet-mãe. Dizer isso evita procurar extensão que não existe.
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('h2', { style: 'font-size:13px' }, 'Ponte com a Verum Wallet')),
      linha('Conector embarcado', state.verumConector?.disponivel ? 'sim, e respondeu' : 'não'),
      state.verumConector?.motivo ? linha('Detalhe', state.verumConector.motivo, 'muted') : null,
      linha('Página dentro de iframe', dentroDeIframe() ? 'sim' : 'não'),
      h('p', { class: 'small muted', style: 'margin-top:10px' }, 'A carteira não injeta nada em sites de fora: a mesa precisa ser aberta pelo app da Verum e embarcar o conector dela. A mesa aceita somente a Verum Wallet.')));
}

async function profilePage() {
  const me = await api('GET', '/api/me');
  return h('div', {}, pageHead('Perfil'),
    h('section', { class: 'panel' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Nome'), h('dd', {}, me.fullName), h('dt', {}, 'E-mail'), h('dd', {}, me.email),
        h('dt', {}, 'Telefone'), h('dd', {}, me.phone), h('dt', {}, 'País'), h('dd', {}, me.country),
        h('dt', {}, 'Carteira'), h('dd', { class: 'mono' }, short(me.wallet)))),
    h('section', { class: 'panel' }, h('h2', {}, 'Privacidade (LGPD)'),
      h('p', { class: 'small', style: 'margin-bottom:12px' }, 'Seus contatos só aparecem para participantes da mesma operação com convite concluído. Você pode pedir a exclusão dos seus dados; registros de operações assinadas, travadas ou auditadas ficam retidos pelo período de obrigação de registro.'),
      me.deletionRequestedAt ? h('p', { class: 'chip chip-status' }, `Exclusão solicitada em ${fmtDate(me.deletionRequestedAt)}`)
        : h('button', { class: 'btn btn-danger', onclick: async () => { try { const r = await api('POST', '/api/me/deletion-request'); toast(r.explanation); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'SOLICITAR EXCLUSÃO DOS MEUS DADOS')),
    h('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:14px', onclick: async () => { await api('POST', '/auth/logout'); state.me = null; location.hash = '#/home'; render(); } }, 'SAIR'));
}

boot();
