// Ponte para a Verum Wallet de verdade (extensão de navegador).
//
// O princípio aqui é o mesmo do resto do projeto: NÃO INVENTAR API. Esta ponte procura o objeto
// que a extensão injeta, reconhece as formas que sabe tratar e normaliza para o contrato interno
// (o mesmo do provider DEMO). Se achar um candidato que não casa com nenhuma forma conhecida, não
// devolve provider: guarda o que viu para a tela de diagnóstico, e a mesa continua dizendo que a
// carteira não está disponível — em vez de chamar métodos adivinhados e falhar de forma obscura.
//
// Tudo que sai daqui é assíncrono. A carteira real pede confirmação ao usuário, então connect e
// signMessage devolvem Promise; o resto do app foi ajustado para esperar (ver core.js).
import { VERUM_PROVIDER_ID, base58Encode } from './wallet-adapter.js';

/** Onde o provider pode aparecer. Ordem = precedência. */
const CANDIDATOS = ['verum', 'verumWallet', 'VerumWallet', 'verumcrypto'];

/**
 * A Verum Wallet é um PWA que abre as plataformas parceiras DENTRO de um iframe dela. Nesse
 * arranjo ela NÃO injeta nada aqui: quem cria `window.verum` é o próprio conector embarcado nesta
 * página, que conversa com a wallet-pai por postMessage — e ele só monta o provider depois que
 * `verumConnector.init()` é chamado.
 *
 * Então o passo que faltava não era procurar melhor: era PEDIR. Sem conector embarcado nada
 * acontece e a mesa segue como hoje.
 */
export async function iniciarConector(escopo = globalThis) {
  const c = escopo?.verumConnector;
  // `embarcado` separa "o arquivo do conector está nesta página" de "a carteira respondeu". Sem essa
  // distinção, um iframe qualquer seria lido como app da Verum e a tela mandaria recados errados.
  if (!c || typeof c.init !== 'function') return { embarcado: false, disponivel: false, motivo: 'conector não embarcado nesta página' };
  try {
    const ok = await c.init();
    return { embarcado: true, disponivel: !!ok, motivo: ok ? null : 'conector embarcado, mas sem carteira-mãe (fora do app da Verum)' };
  } catch (e) {
    return { embarcado: true, disponivel: false, motivo: `conector falhou ao iniciar: ${(e && e.message) || e}` };
  }
}

/**
 * Espião de postMessage.
 *
 * Quando a carteira mostra a janela, a pessoa assina e a mesa continua esperando, só há três
 * explicações: nada voltou, voltou de uma origem que o conector descarta, ou voltou com um nome ou
 * um id que ele não reconhece. Adivinhar qual delas é perda de tempo — este ouvinte registra a
 * FORMA do que chega (origem, tipo, chaves) e a tela mostra, virando print em vez de palpite.
 *
 * Deliberadamente NÃO guarda o conteúdo: a assinatura e a mensagem não precisam ir para a tela de
 * diagnóstico, e dado pessoal muito menos. Chave, não valor.
 */
const VISTAS = [];
const LIMITE = 24;
let espiando = false;

export function espiarMensagens(escopo = globalThis) {
  if (espiando || typeof escopo?.addEventListener !== 'function') return () => undefined;
  espiando = true;
  const ouvir = (e) => {
    const d = e?.data;
    if (!d || typeof d !== 'object') return;
    const tipo = typeof d.type === 'string' ? d.type : '(sem type)';
    if (!/^VERUM_/.test(tipo)) return;              // só o protocolo da carteira; o resto é ruído
    VISTAS.push({
      origem: e.origin || '(sem origem)',
      tipo,
      chaves: Object.keys(d).filter((k) => k !== 'type').sort(),
    });
    if (VISTAS.length > LIMITE) VISTAS.shift();
  };
  escopo.addEventListener('message', ouvir);
  return () => { escopo.removeEventListener('message', ouvir); espiando = false; };
}

/** O que a carteira mandou até agora, na ordem. */
export function mensagensVistas() { return VISTAS.slice(); }

/** Esta página está dentro de um iframe? É o arranjo em que a wallet abre as parceiras. */
export function dentroDeIframe(escopo = globalThis) {
  try { return escopo.self !== escopo.top; } catch { return true; }   // cross-origin lança: é iframe
}

/**
 * Rede de segurança para a resposta de assinatura.
 *
 * O conector só aceita a resposta quando ela vem com o tipo EXATO `VERUM_SIGN_MSG_RESPONSE` e com
 * o campo `id`. O comentário dele mesmo registra que o protocolo tem duas grafias convivendo (`id`
 * e `requestId`, §9.1 do getAddresses) — então uma carteira que responda pela outra grafia, ou com
 * o tipo escrito por extenso, assina de verdade e a mesa fica esperando para sempre.
 *
 * Isto NÃO é inventar protocolo: é aceitar a mesma mensagem com o casamento mais frouxo, e só
 * enquanto há pedido em curso. Aceitar não é confiar: quem julga a assinatura é o SERVIDOR, que a
 * verifica contra a mensagem e o nonce que ele próprio emitiu. Origem continua filtrada.
 */
function ouvirRespostaDeAssinatura(escopo) {
  let parar = () => undefined;
  const promessa = new Promise((resolve, reject) => {
    if (typeof escopo?.addEventListener !== 'function') return;     // sem janela: nada a ouvir
    const permitidas = Array.isArray(escopo.__VERUM_WALLET_ORIGINS__) ? escopo.__VERUM_WALLET_ORIGINS__ : [];
    const ouvir = (e) => {
      if (permitidas.length && !permitidas.includes(e.origin)) return;
      const d = e?.data;
      const t = typeof d?.type === 'string' ? d.type : '';
      if (!/^VERUM_SIGN_(MSG|MESSAGE)_/i.test(t)) return;
      if (/REJECT/i.test(t)) { parar(); reject(new Error(d.reason || 'USER_REJECTED')); return; }
      const sig = d.signature ?? d.signedMessage ?? d.result?.signature;
      if (!sig) return;
      parar();
      resolve({ signature: sig, publicKey: d.publicKey, viaResgate: true });
    };
    escopo.addEventListener('message', ouvir);
    parar = () => escopo.removeEventListener?.('message', ouvir);
  });
  promessa.catch(() => undefined);     // o perdedor da corrida não pode virar rejeição sem dono
  return { promessa, parar: () => parar() };
}

/** Houve resposta que só chegou pela rede de segurança? O diagnóstico conta, e o relato ao time da carteira fica preciso. */
let resgatou = false;
export function assinaturaVeioPorResgate() { return resgatou; }

const ehFuncao = (o, k) => typeof o?.[k] === 'function';
const metodos = (o) => { try { return Object.keys(o).filter((k) => ehFuncao(o, k)).sort(); } catch { return []; } };

/** Marca da Verum: ou o objeto se identifica, ou veio pelo nome reservado dela. */
const pareceVerum = (o, nome) => !!o && (o.isVerumWallet === true || o.isVerum === true || o.id === VERUM_PROVIDER_ID || CANDIDATOS.includes(nome));

/** base64 → bytes. Devolve null quando não é base64 válido, em vez de explodir no meio da assinatura. */
function b64ParaBytes(s) {
  try {
    const bin = atob(String(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/** Assinatura pode voltar como base58, bytes, ou dentro de { signature }. Normaliza para base58. */
function paraBase58(resultado) {
  const v = resultado?.signature ?? resultado;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return base58Encode(v);
  if (Array.isArray(v)) return base58Encode(Uint8Array.from(v));
  if (v?.buffer instanceof ArrayBuffer) return base58Encode(new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength));
  throw new Error('A Verum Wallet devolveu a assinatura num formato que esta mesa não reconhece.');
}

/** Endereço pode vir como string, { address }, { publicKey } ou PublicKey com toBase58(). */
function paraEndereco(v) {
  const p = v?.address ?? v?.publicKey ?? v;
  if (typeof p === 'string') return p;
  if (ehFuncao(p, 'toBase58')) return p.toBase58();
  if (typeof p?.toString === 'function' && !(p instanceof Object.getPrototypeOf(Object))) {
    const s = String(p);
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  }
  return null;
}

/**
 * Normaliza um objeto injetado para o contrato interno. Devolve null quando a forma não é
 * reconhecida — quem chama registra o motivo para o diagnóstico.
 */
export function normalizarProvider(bruto, nome, escopo = globalThis) {
  if (!pareceVerum(bruto, nome) || !ehFuncao(bruto, 'signMessage')) return null;
  const conectar = ['connect', 'enable', 'requestAccounts'].find((k) => ehFuncao(bruto, k));
  if (!conectar) return null;

  const p = {
    id: VERUM_PROVIDER_ID,
    isVerumWallet: true,
    demo: false,
    origem: nome,
    label: bruto.label ?? 'Verum Wallet',
    /** @type {{ key: string, address: string, name: string, kind: string } | null} */
    current: /** @type {any} */ (null),
    bruto,
    /**
     * O que a carteira DECLARA saber fazer. Chega no handshake, depois da normalização — por isso
     * é getter, não cópia. Lista vazia = carteira que não declara nada (aí tentar é o certo); lista
     * cheia sem 'signMessage' = ela avisou que não assina mensagem, e insistir só rende dois
     * minutos de espera por uma resposta que não vem.
     */
    get capacidades() { return Array.isArray(bruto.capabilities) ? bruto.capabilities : []; },
    async connect() {
      const r = await bruto[conectar]();
      const address = paraEndereco(r) ?? paraEndereco(bruto);
      if (!address) throw new Error('A Verum Wallet conectou mas não informou o endereço da carteira.');
      p.current = { key: address, address, name: 'Verum Wallet', kind: 'verum' };
      return p.current;
    },
    /** A extensão expõe a conta ativa, não uma lista: conectar é o que revela qual é. */
    async accounts() {
      if (!p.current) { try { await p.connect(); } catch { return []; } }
      return p.current ? [p.current] : [];
    },
    async signMessage(message) {
      if (!p.current) await p.connect();
      const bytes = new TextEncoder().encode(message);
      // A rede de segurança escuta em paralelo: se a carteira responder por uma grafia que o
      // conector não casa, quem chega primeiro resolve. Instalada ANTES do pedido, senão a resposta
      // rápida passaria antes do ouvinte existir.
      const resgate = ouvirRespostaDeAssinatura(escopo);
      try {
        // Algumas carteiras recebem texto, outras bytes. Tenta bytes (padrão Solana) e cai para texto.
        const peloConector = (async () => {
          try { return await bruto.signMessage(bytes, 'utf8'); }
          catch (e) {
            if (/string|text|argument|invalid/i.test(String(e?.message ?? ''))) return bruto.signMessage(message);
            throw e;
          }
        })();
        const r = await Promise.race([peloConector, resgate.promessa]);
        if (r?.viaResgate) {
          resgatou = true;
          // Contrato do conector: a carteira manda a assinatura em base64. 64 bytes confirmam que
          // era base64 mesmo; não batendo, devolve como veio (pode já ser base58) e o servidor julga.
          const b = b64ParaBytes(r.signature);
          return b && b.length === 64 ? base58Encode(b) : r.signature;
        }
        return paraBase58(r);
      } finally { resgate.parar(); }
    },
  };
  return p;
}

/**
 * Varre o ambiente. Devolve { providers, sonda } — a sonda é o retrato do que foi visto, para a
 * tela de diagnóstico mostrar por que uma carteira presente não foi aceita.
 */
/**
 * Quando nada é reconhecido, "não achei" não ajuda ninguém. Isto lista os globais do navegador com
 * cara de carteira para o diagnóstico mostrar o nome real do objeto que a extensão injetou — é
 * assim que se descobre a API de uma extensão nova sem adivinhar.
 */
// Coisas NOSSAS que casam com o filtro de nome e não são carteira nenhuma: a lista de origens que o
// próprio servidor injeta e o conector da Verum (que tem seção própria no diagnóstico). Listá-los
// como "carteira recusada — formato não reconhecido" é acusar o app de um defeito que não existe.
const NAO_SAO_CARTEIRA = ['__VERUM_WALLET_ORIGINS__', 'verumConnector'];

export function pistasDeCarteira(escopo = globalThis) {
  const out = [];
  let chaves = [];
  try { chaves = Object.keys(escopo); } catch { return out; }
  for (const k of chaves) {
    if (!/verum|wallet|solana|phantom|backpack|sollet|glow/i.test(k)) continue;
    if (NAO_SAO_CARTEIRA.includes(k)) continue;
    let v;
    try { v = escopo[k]; } catch { continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;   // lista de strings não é provider
    const m = metodos(v);
    if (!m.length) continue;                                          // objeto sem método não assina nada
    out.push({ onde: `window.${k}`, metodos: m });
  }
  return out;
}

export function detectVerumProviders(escopo = globalThis) {
  const providers = [];
  const sonda = [];
  for (const nome of CANDIDATOS) {
    const bruto = escopo?.[nome];
    if (!bruto || typeof bruto !== 'object') continue;
    const p = normalizarProvider(bruto, nome, escopo);
    sonda.push({
      onde: `window.${nome}`,
      aceito: !!p,
      motivo: p ? null : (!ehFuncao(bruto, 'signMessage') ? 'sem signMessage' : 'sem connect/enable/requestAccounts'),
      metodos: metodos(bruto),
    });
    if (p) providers.push(p);
  }
  // Outras carteiras Solana (Phantom, Solflare) são deliberadamente ignoradas: esta mesa aceita
  // somente a Verum Wallet. Aparecem na sonda só para o diagnóstico explicar a ausência.
  const outra = escopo?.solana;
  if (outra && typeof outra === 'object' && !pareceVerum(outra, 'solana')) {
    sonda.push({ onde: 'window.solana', aceito: false, motivo: 'outra carteira: a mesa aceita somente a Verum Wallet', metodos: metodos(outra) });
  }
  // Nenhuma carteira reconhecida: junta as pistas, para o diagnóstico dizer o que EXISTE no
  // navegador em vez de só "não encontrada".
  if (!providers.length) {
    const vistos = new Set(sonda.map((x) => x.onde));
    for (const p of pistasDeCarteira(escopo)) {
      if (!vistos.has(p.onde)) sonda.push({ onde: p.onde, aceito: false, motivo: 'objeto encontrado, formato não reconhecido', metodos: p.metodos });
    }
  }
  return { providers, sonda };
}

/**
 * A extensão pode injetar depois do primeiro render. Chama de volta quando algo novo aparecer,
 * no máximo uma vez, para a tela se refazer com a carteira já disponível.
 */
export function onVerumReady(cb, escopo = globalThis) {
  let feito = false;
  const disparar = () => { if (feito) return; if (!detectVerumProviders(escopo).providers.length) return; feito = true; parar(); cb(); };
  const eventos = ['verum#initialized', 'verum:ready', 'wallet-standard:register-wallet'];
  for (const e of eventos) escopo.addEventListener?.(e, disparar);
  const timer = escopo.setInterval?.(disparar, 400);
  const prazo = escopo.setTimeout?.(() => parar(), 5000);     // extensão que não chega em 5s não vem
  function parar() {
    for (const e of eventos) escopo.removeEventListener?.(e, disparar);
    escopo.clearInterval?.(timer); escopo.clearTimeout?.(prazo);
  }
  // Checa JÁ: a carteira pode ter aparecido entre a montagem do adapter e esta chamada. Sem isto,
  // "já está presente" seria lido como "nada a fazer" e a tela continuaria dizendo que não achou.
  disparar();
  return parar;
}
