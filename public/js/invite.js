// Fluxo do parceiro a partir do link /i/:token. O GET da página nunca consome o convite.
import { h, add, clear, api, toast, brand, getAdapter, resetAdapter, walletPick, walletSign, state } from './core.js';
import { choiceState } from './onboarding-logic.js';

const GENERIC = 'Este convite não é mais válido. Peça um novo link.';

export function startInvite(root, token) {
  const st = { step: 'ENTRY', summary: null, wallet: null, error: null, busy: false, existing: false };

  const steps = ['CHOICE', 'CODE', 'WALLET', 'SIGNUP', 'TERMS'];
  const progress = () => h('div', { class: 'steps', 'aria-hidden': 'true' }, steps.map((s, i) => h('i', { class: steps.indexOf(st.step) >= i ? 'on' : '' })));
  const fail = (e) => {
    // Mostra o motivo que o servidor deu, em vez de um texto fixo: no servidor real ele é
    // sempre o GENERIC (de propósito, para não revelar se um token existe), mas a
    // pré-visualização sabe distinguir "aberto em outro navegador" de "já usado".
    if (e.code === 'INVITE_INVALID' || e.status === 404) { st.step = 'INVALID'; st.invalidReason = e.message || GENERIC; draw(); return; }
    st.error = e.message; draw();
  };
  const summaryBox = () => st.summary ? h('div', { class: 'panel', style: 'margin-bottom:16px' },
    h('div', { class: 'row' }, h('span', { class: 'chip chip-seal' }, st.summary.kind === 'UNICA' ? 'OFERTA ÚNICA' : 'PARCERIA PERMANENTE'), h('span', { class: 'mono small' }, st.summary.dealCode)),
    h('div', { class: 'direction', style: 'font-size:26px' }, `${st.summary.direction.deliver.split(':')[0]} → ${st.summary.direction.receive.split(':')[0]}`),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Operação'), h('dd', {}, st.summary.title),
      h('dt', {}, 'Sua função'), h('dd', {}, st.summary.role),
      h('dt', {}, 'Seu percentual'), h('dd', { class: 'mono' }, st.summary.bpsLabel)),
    h('p', { class: 'small muted' }, 'Função e percentual foram definidos pelo responsável da mesa e não podem ser alterados aqui.')) : null;

  function draw() {
    clear(root);
    const wrap = h('main', { class: 'gate' }, brand('Convite privado'));
    const err = st.error ? h('p', { class: 'form-error', role: 'alert' }, st.error) : null;
    st.error = null;

    if (st.step === 'ENTRY') {
      add(wrap, 
        h('h1', {}, 'Convite privado VERUM NCNDA'),
        h('p', { class: 'lead' }, 'Toque para abrir. Atenção: o convite só abre uma vez, neste aparelho.'),
        h('button', { class: 'btn btn-primary btn-block', disabled: st.busy, onclick: open }, 'ABRIR CONVITE'), err);
    } else if (st.step === 'INVALID') {
      add(wrap, h('h1', {}, 'Convite indisponível'), h('p', { class: 'lead' }, st.invalidReason || GENERIC));
    } else if (st.step === 'CHOICE') {
      const ad = getAdapter();
      const cs = choiceState({ walletAvailable: ad.isAvailable(), downloadUrl: state.config?.walletDownloadUrl });
      add(wrap, progress(),
        h('h1', {}, 'Como você quer seguir?'),
        h('p', { class: 'lead' }, 'Para entrar na mesa você precisa da Verum Wallet, a carteira de autocustódia em que as chaves ficam só com você.'),
        h('div', { class: 'choice' },
          h('button', { class: `btn ${cs.primary === 'signup' ? 'btn-primary' : 'btn-ghost'}`, disabled: cs.signupDisabled, onclick: () => { st.step = 'CODE'; draw(); } }, 'CRIAR CADASTRO (tenho a Verum Wallet)'),
          cs.signupDisabled ? h('p', { class: 'hint' }, cs.signupReason) : null,
          cs.showDownload
            ? h('a', { class: `btn ${cs.primary === 'download' ? 'btn-primary' : 'btn-ghost'}`, href: cs.downloadUrl, target: '_blank', rel: 'noopener noreferrer', onclick: () => { st.afterDownload = true; setTimeout(draw, 50); } }, 'NÃO TENHO A VERUM WALLET — BAIXAR')
            : h('div', { class: `notice ${cs.primary === 'download' ? 'notice-info' : ''}` }, 'Não tem a Verum Wallet? ', cs.downloadFallback),
          (st.afterDownload || cs.primary === 'download') ? h('p', { class: 'notice notice-risk' }, cs.afterInstall + ' Este link já foi aberto e não serve para um novo acesso.') : null),
        state.config?.demoMode ? h('button', {
          class: 'btn btn-ghost btn-sm', style: 'margin-top:18px', onclick: () => {
            const on = sessionStorage.getItem('votc-sim-no-wallet') === '1';
            sessionStorage.setItem('votc-sim-no-wallet', on ? '0' : '1'); resetAdapter(); draw();
          },
        }, sessionStorage.getItem('votc-sim-no-wallet') === '1' ? 'DEMO: voltar a ter a Verum Wallet' : 'DEMO: simular aparelho sem Verum Wallet') : null, err);
    } else if (st.step === 'CODE') {
      const input = h('input', { class: 'code-input', inputmode: 'text', autocomplete: 'one-time-code', placeholder: 'VOTC-XXXXXX', maxlength: '11', 'aria-label': 'Código do convite' });
      add(wrap, progress(), h('h1', {}, 'Código do convite'),
        h('p', { class: 'lead' }, 'Digite o código que veio junto com o link.'),
        h('form', { onsubmit: (e) => { e.preventDefault(); verify(input.value); } },
          input, err, h('button', { class: 'btn btn-primary btn-block', style: 'margin-top:14px', disabled: st.busy }, 'CONFIRMAR CÓDIGO')));
      setTimeout(() => input.focus(), 30);
    } else if (st.step === 'WALLET') {
      add(wrap, progress(), h('h1', {}, 'Conecte a Verum Wallet'), summaryBox(),
        h('p', { class: 'lead' }, 'Você vai assinar uma mensagem que prova que a carteira é sua. Não é transação e não movimenta fundos. Nunca pedimos seed, chave privada ou senha.'),
        h('button', { class: 'btn btn-primary btn-block', disabled: st.busy, onclick: connect }, 'CONECTAR VERUM WALLET'), err);
    } else if (st.step === 'SIGNUP') {
      const f = {
        fullName: h('input', { autocomplete: 'name', required: true, maxlength: '120' }),
        email: h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '254' }),
        phone: h('input', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '+55 11 91234-5678', maxlength: '24' }),
        country: h('select', {}, [['BR', 'Brasil'], ['PY', 'Paraguai'], ['AR', 'Argentina'], ['UY', 'Uruguai'], ['US', 'Estados Unidos'], ['PT', 'Portugal'], ['AE', 'Emirados Árabes'], ['CH', 'Suíça']].map(([v, l]) => h('option', { value: v }, l))),
      };
      add(wrap, progress(), h('h1', {}, 'Cadastro'),
        h('p', { class: 'lead' }, `Carteira ${st.wallet ? st.wallet.slice(0, 4) + '...' + st.wallet.slice(-4) : ''} conectada. Seus contatos só ficam visíveis para participantes desta operação com convite concluído.`),
        h('form', { onsubmit: (e) => { e.preventDefault(); signup({ fullName: f.fullName.value, email: f.email.value, phone: f.phone.value, country: f.country.value }); } },
          h('label', { class: 'field' }, h('span', {}, 'Nome completo'), f.fullName),
          h('label', { class: 'field' }, h('span', {}, 'E-mail'), f.email),
          h('label', { class: 'field' }, h('span', {}, 'Telefone / WhatsApp'), f.phone),
          h('label', { class: 'field' }, h('span', {}, 'País'), f.country), err,
          h('button', { class: 'btn btn-primary btn-block', disabled: st.busy }, 'CONTINUAR')));
    } else if (st.step === 'TERMS') {
      const cb = h('input', { type: 'checkbox', style: 'width:22px;min-height:22px;height:22px;margin:0' });
      add(wrap, progress(), h('h1', {}, 'Termos de participação'), summaryBox(),
        st.existing ? h('p', { class: 'notice notice-info', style: 'margin-bottom:12px' }, 'Carteira já cadastrada em outra mesa: o convite será vinculado ao seu cadastro existente.') : null,
        h('ul', { class: 'conditions', style: 'margin-bottom:16px' },
          h('li', {}, 'Ambiente privado, sem custódia: a Verum nunca guarda fundos, seed, chave privada ou senha.'),
          h('li', {}, 'Assinar a parceria é assinatura de mensagem. Autorizar liquidação é uma etapa separada, explicada antes.'),
          h('li', {}, 'Pernas fora da plataforma (espécie, fiat, ativo físico) não são verificadas nem garantidas por contrato.'),
          h('li', {}, 'Regras comerciais travadas só mudam por nova versão, com novos aceites de todos.'),
          h('li', {}, 'Seus dados seguem a LGPD: finalidade, minimização e exclusão, exceto registros de operações assinadas/auditadas.')),
        h('label', { style: 'display:flex;gap:12px;align-items:center;min-height:44px;margin-bottom:14px' }, cb, h('span', {}, 'Li e aceito os termos')), err,
        h('button', { class: 'btn btn-primary btn-block', disabled: st.busy, onclick: () => (cb.checked ? complete() : (st.error = 'Aceite os termos para entrar.', draw())) }, 'ACEITAR E ENTRAR NA DEAL ROOM'));
    }
    if (state.config?.demoMode) add(wrap, h('p', { class: 'small muted', style: 'margin-top:26px;text-align:center' }, 'DEMO / TESTNET — NO REAL FUNDS'));
    root.append(wrap);
  }

  const busy = async (fn) => { st.busy = true; draw(); try { await fn(); } catch (e) { fail(e); } finally { st.busy = false; if (st.step !== 'INVALID') draw(); } };

  const open = () => busy(async () => { await api('POST', '/invite/open', { token }); st.step = 'CHOICE'; });
  const verify = (code) => busy(async () => {
    try {
      const r = await api('POST', '/invite/verify-code', { token, code });
      st.summary = r.summary; st.step = 'WALLET';
    } catch (e) {
      if (e.code === 'CODE_INVALID') { st.error = e.message; return; }
      throw e;
    }
  });
  const connect = async () => {
    try {
      const acc = await walletPick({ title: 'Conectar Verum Wallet' });
      const ad = getAdapter();
      ad.use(acc.provider ?? ad.provider);
      await ad.provider.connect(acc.key);
      const ch = await api('POST', '/invite/wallet-challenge', { token, address: acc.address });
      const signature = await walletSign(ch.message, { title: 'Prova de posse da carteira', action: 'ASSINAR' });
      await busy(async () => {
        const r = await api('POST', '/invite/wallet-verify', { token, challengeId: ch.challengeId, nonce: ch.nonce, signature });
        st.wallet = r.walletAddress; st.existing = r.existingUser; st.step = r.step;
      });
    } catch (e) { if (e.code !== 'CANCELLED') fail(e); }
  };
  const signup = (data) => busy(async () => { await api('POST', '/invite/signup', { token, ...data }); st.step = 'TERMS'; });
  const complete = () => busy(async () => {
    const r = await api('POST', '/invite/complete', { token, acceptTerms: true });
    toast('Convite concluído. Bem-vindo à mesa.');
    location.replace(`/#/deal/${r.dealId}`);
  });

  // Mesmo navegador dentro da janela de retomada: continua de onde parou. Caso contrário, tela de entrada.
  (async () => {
    try {
      const r = await api('POST', '/invite/resume', { token });
      st.summary = r.summary; st.wallet = r.walletAddress;
      st.step = r.step === 'CHOICE' ? 'CHOICE' : r.step;
      st.existing = r.step === 'TERMS' && !!r.walletAddress;
    } catch { st.step = 'ENTRY'; }
    draw();
  })();
}
