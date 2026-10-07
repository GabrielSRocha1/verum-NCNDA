// O conector da Verum Wallet (public/vendor/verum-connector.js) é código de TERCEIRO, vendorizado
// do portal da Verum. Nada no typecheck ou nos outros testes olha para dentro dele: se uma versão
// nova mudar o nome de uma mensagem, o formato da assinatura ou o jeito de instalar window.verum,
// a mesa simplesmente deixaria de conectar DENTRO do app da Verum — o único lugar onde isso roda.
//
// Aqui a wallet-mãe é simulada: um iframe de mentira, o conector de verdade rodando num vm, e uma
// carteira Ed25519 real do outro lado do postMessage. O que se prova é a cadeia inteira — ponte
// sobe, a mesa aceita o provider, o endereço casa, e a assinatura que chega é VÁLIDA para a
// mensagem assinada, isto é, passaria pela verificação do servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import nacl from 'tweetnacl';
import { detectVerumProviders, iniciarConector, dentroDeIframe, assinaturaVeioPorResgate } from '../public/js/verum-provider.js';
import { podeAssinarMensagem } from '../public/js/core.js';
import { base58Encode } from '../public/js/wallet-adapter.js';
import { base58Decode } from '../src/lib/crypto.ts';

const WALLET = 'https://www.verumcrypto.com';
const CONECTOR = readFileSync(new URL('../public/vendor/verum-connector.js', import.meta.url), 'utf8');

// O conector dá REQUEST_TIMEOUT_MS = 120s para a pessoa confirmar na carteira — certo no navegador,
// mas no teste um pedido deliberadamente ignorado prenderia o processo por dois minutos. Timer sem
// ref não segura o event loop; o comportamento do conector não muda.
const solto = (f: any, ms?: number) => { const t = setTimeout(f, ms as number); t.unref?.(); return t; };

/** Monta o navegador de mentira com o conector real já carregado. `origens` = o que /verum-origins.js injeta. */
function montarIframe(origens: string[], chave: nacl.SignKeyPair) {
  const endereco = base58Encode(chave.publicKey);
  const ouvintes: Array<(e: any) => void> = [];
  const aoPai: Array<{ data: any, targetOrigin: string }> = [];
  const win: any = {
    self: {}, top: {},                                  // self !== top => é iframe
    location: { origin: 'https://verum-ncnda.vercel.app' },
    addEventListener: (t: string, cb: any) => { if (t === 'message') ouvintes.push(cb); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    parent: { postMessage: (data: any, targetOrigin: string) => aoPai.push({ data, targetOrigin }) },
    setTimeout: solto, clearTimeout, setInterval, clearInterval,
    __VERUM_WALLET_ORIGINS__: origens,
  };
  win.window = win;
  vm.runInContext(CONECTOR, vm.createContext({
    window: win, document: { referrer: `${WALLET}/dapp-browser` }, navigator: { userAgent: 'node' },
    setTimeout: solto, clearTimeout, setInterval, clearInterval, console: { log() {}, warn() {}, error() {} },
    URL, CustomEvent: class { constructor(t: string, o: any) { Object.assign(this, { type: t }, o); } },
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array, TextEncoder, Promise, Error, Array, Object, JSON, Math, Date,
  }));

  /** A wallet-mãe atende o que estiver na fila: handshake, conexão e assinatura de verdade. */
  const paiAtende = (origem = WALLET) => {
    const vistas: string[] = [];
    for (const m of aoPai.splice(0)) {
      const d = m.data;
      vistas.push(`${d.type}@${m.targetOrigin}`);
      let resp: any = null;
      if (d.type === 'VERUM_INIT_REQUEST') resp = { type: 'VERUM_INIT_RESPONSE', publicKey: endereco, capabilities: ['signMessage'] };
      if (d.type === 'VERUM_CONNECT_REQUEST') resp = { type: 'VERUM_CONNECT_RESPONSE', id: d.id, publicKey: endereco };
      if (d.type === 'VERUM_SIGN_MSG_REQUEST') {
        const sig = nacl.sign.detached(new Uint8Array(Buffer.from(d.message, 'base64')), chave.secretKey);
        resp = { type: 'VERUM_SIGN_MSG_RESPONSE', id: d.id, signature: Buffer.from(sig).toString('base64'), publicKey: endereco };
      }
      if (resp) for (const cb of ouvintes) cb({ origin: origem, data: resp });
    }
    return vistas;
  };
  // Entrega uma mensagem crua aos ouvintes, sem passar pela fila: é como se a wallet-mãe tivesse
  // mandado algo por conta própria — inclusive o que o conector não sabe casar.
  win.__entregar = (data: any, origem = WALLET) => { for (const cb of ouvintes) cb({ origin: origem, data }); };

  return { win, endereco, paiAtende };
}

const respira = () => new Promise((r) => setTimeout(r, 10));

test('1. dentro do app da Verum a ponte sobe, a mesa aceita o provider e a assinatura é verificável', async () => {
  const chave = nacl.sign.keyPair();
  const { win, endereco, paiAtende } = montarIframe([WALLET], chave);

  assert.equal(dentroDeIframe(win), true);
  // É o conector (dela) que cria window.verum; init() é o pedido que faltava — sem ele, nada existe.
  const r = await iniciarConector(win);
  assert.deepEqual(r, { embarcado: true, disponivel: true, motivo: null });
  assert.equal(win.verum?.isVerum, true);

  const { providers, sonda } = detectVerumProviders(win);
  assert.equal(providers.length, 1, 'a mesa tem de aceitar o provider que o conector real instala');
  assert.deepEqual(sonda.map((s: any) => [s.onde, s.aceito]), [['window.verum', true]]);

  const conectando = providers[0].connect();
  paiAtende();
  assert.equal((await conectando).address, endereco, 'o endereço é o da carteira do outro lado da ponte');

  const MSG = 'VERUM NCNDA\nAcao: ENTRAR\nDominio: verum-ncnda.vercel.app\nNonce: abc123';
  const assinando = providers[0].signMessage(MSG);
  await respira(); paiAtende();
  const assinatura = await assinando;

  // O teste de verdade: é exatamente esta conta que o servidor faz em loginVerify.
  assert.equal(base58Decode(assinatura).length, 64, 'Ed25519 detached tem 64 bytes');
  assert.ok(
    nacl.sign.detached.verify(new TextEncoder().encode(MSG), base58Decode(assinatura), base58Decode(endereco)),
    'assinatura recusada pela verificação do servidor: a ponte entregou outro formato');
});

test('2. a lista de origens é usada: a mensagem a assinar não sai para quem não é a wallet', async () => {
  const chave = nacl.sign.keyPair();
  const { win, paiAtende } = montarIframe([WALLET], chave);
  await iniciarConector(win);
  const [p] = detectVerumProviders(win).providers;

  const conectando = p.connect();
  const vistas = paiAtende();
  await conectando;
  // targetOrigin '*' entregaria o pedido a QUALQUER página que nos enquadrasse. Com a lista, não.
  assert.ok(vistas.every((v) => v.endsWith(`@${WALLET}`)), `pedido vazou para outra origem: ${vistas.join(', ')}`);

  // E a volta: resposta de origem estranha é descartada em silêncio — a promessa fica pendente.
  const pedido = p.signMessage('qualquer coisa');
  await respira();
  paiAtende('https://atacante.exemplo');
  const desfecho = await Promise.race([pedido.then(() => 'ACEITOU'), new Promise((r) => setTimeout(() => r('ignorou'), 150))]);
  assert.equal(desfecho, 'ignorou', 'o conector aceitou assinatura vinda de origem não autorizada');
  pedido.catch(() => undefined);
});

test('2b. carteira que assina e responde pela OUTRA grafia não deixa a mesa esperando para sempre', async () => {
  const chave = nacl.sign.keyPair();
  const { win, endereco, paiAtende } = montarIframe([WALLET], chave);
  await iniciarConector(win);
  const [p] = detectVerumProviders(win).providers;
  // Conectar PRIMEIRO: signMessage conecta sozinho quando não há conta, e aí o teste mediria o
  // travamento do connect em vez do da assinatura — que é o que se quer provar aqui.
  const conectando = p.connect(); paiAtende(); await conectando;

  // O conector só casa a resposta por `type: 'VERUM_SIGN_MSG_RESPONSE'` COM campo `id`. O comentário
  // dele mesmo registra que o protocolo tem duas grafias (`id` e `requestId`). Aqui a wallet-mãe
  // assina de verdade e responde pela outra — sem a rede de segurança, a promessa nunca resolve.
  const MSG = 'VERUM NCNDA\nProva de posse de carteira (login)\nNonce: xyz';
  const assinando = p.signMessage(MSG);
  await new Promise((r) => setTimeout(r, 10));

  const sig = nacl.sign.detached(new TextEncoder().encode(MSG), chave.secretKey);
  (win as any).__entregar({
    type: 'VERUM_SIGN_MSG_RESPONSE',
    requestId: 'id-que-o-conector-nao-casa',
    signature: Buffer.from(sig).toString('base64'),
    publicKey: endereco,
  });

  const assinatura = await Promise.race([assinando, new Promise((r) => setTimeout(() => r('PENDURADO'), 300))]);
  assert.notEqual(assinatura, 'PENDURADO', 'a mesa ficou esperando uma resposta que já tinha chegado');
  // E o que chega tem de ser base58 válido para o servidor: a carteira manda base64.
  assert.ok(
    nacl.sign.detached.verify(new TextEncoder().encode(MSG), base58Decode(assinatura as string), base58Decode(endereco)),
    'a assinatura resgatada precisa passar na verificação do servidor');
  assert.equal(assinaturaVeioPorResgate(), true, 'o diagnóstico precisa saber que veio pela rede de segurança');
});

test('2c. a rede de segurança não aceita assinatura de origem fora da lista', async () => {
  const chave = nacl.sign.keyPair();
  const { win, endereco, paiAtende } = montarIframe([WALLET], chave);
  await iniciarConector(win);
  const [p] = detectVerumProviders(win).providers;
  const conectando = p.connect(); paiAtende(); await conectando;   // senão o teste mede o connect

  const MSG = 'qualquer coisa';
  const assinando = p.signMessage(MSG);
  await new Promise((r) => setTimeout(r, 10));
  const sig = nacl.sign.detached(new TextEncoder().encode(MSG), chave.secretKey);
  (win as any).__entregar({
    type: 'VERUM_SIGN_MSG_RESPONSE', requestId: 'x',
    signature: Buffer.from(sig).toString('base64'), publicKey: endereco,
  }, 'https://atacante.exemplo');

  const desfecho = await Promise.race([assinando.then(() => 'ACEITOU'), new Promise((r) => setTimeout(() => r('ignorou'), 250))]);
  assert.equal(desfecho, 'ignorou', 'aceitou assinatura vinda de origem não autorizada');
  assinando.catch(() => undefined);
});

test('3. carteira muda não vira silêncio na tela, e o que ela declara saber é respeitado', async () => {
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const core = await import('../public/js/core.js');

  // Este é o caso que aconteceu de verdade: o desafio foi criado no servidor, a carteira não
  // respondeu ao pedido de assinatura, o conector cortou em TIMEOUT — e a mesa tratava isso como
  // cancelamento, que quem chama ignora em silêncio. Resultado: nada na tela, nada no banco.
  const mudo = core.falhaDeAssinatura(new Error('TIMEOUT'));
  assert.equal(mudo.code, 'WALLET_TIMEOUT', 'carteira sem resposta não pode virar cancelamento');
  assert.match(mudo.message, /não respondeu/);

  // Recusar é diferente de não responder: recusa é decisão da pessoa e segue em silêncio.
  assert.equal(core.falhaDeAssinatura(new Error('USER_REJECTED')).code, 'CANCELLED');
  assert.equal(core.falhaDeAssinatura(new Error('VERUM_SIGN_MSG_REJECTED')).code, 'CANCELLED');
  assert.equal(core.falhaDeAssinatura(new Error('rede caiu')).code, 'WALLET_ERROR');

  // Capacidades declaradas no handshake: sem 'signMessage' a mesa não tem como entrar, e falar
  // isso na hora é melhor do que esperar o prazo do conector por uma resposta que não vem.
  assert.equal(core.podeAssinarMensagem({ capacidades: ['signMessage', 'getAddresses'] } as any), true);
  assert.equal(core.podeAssinarMensagem({ capacidades: ['signAndSendPayment'] } as any), false);
  // Carteira que não declara nada é carteira antiga: aí tentar é o certo, não presumir ausência.
  assert.equal(core.podeAssinarMensagem({ capacidades: [] } as any), true);
  assert.equal(core.podeAssinarMensagem({} as any), true);
});

test('4. as capacidades vêm da carteira em tempo real: chegam no handshake, depois da normalização', async () => {
  const chave = nacl.sign.keyPair();
  const { win, paiAtende } = montarIframe([WALLET], chave);
  await iniciarConector(win);
  const [p] = detectVerumProviders(win).providers;

  // Array.from porque a lista nasce dentro do vm: outro realm, outro Array.prototype, e o
  // deepStrictEqual repara nisso. No navegador é tudo o mesmo realm — artefato do arnês.
  // Antes de a wallet-mãe atender o handshake, ninguém declarou nada — e "não declarou" tem de
  // significar "tente mesmo assim", nunca "não sabe assinar".
  assert.deepEqual(Array.from(p.capacidades), []);

  // A wallet-mãe deste teste declara ['signMessage'] no VERUM_INIT_RESPONSE. Se `capacidades` fosse
  // uma cópia feita na normalização, continuaria vazia — o handshake acontece DEPOIS da detecção.
  paiAtende();
  assert.deepEqual(Array.from(p.capacidades), ['signMessage'], 'capacidades têm de refletir o handshake, não o instante da detecção');
  assert.equal(podeAssinarMensagem(p), true, 'declarou signMessage: a mesa tem de seguir');
});

test('5. fora do app da Verum nada muda: sem conector a mesa segue dizendo que a carteira não está lá', async () => {
  // Navegador comum, página de primeiro nível: o conector nem instala a ponte.
  // embarcado:false é o que impede a tela de tratar um iframe qualquer como app da Verum.
  assert.deepEqual(await iniciarConector({} as any), { embarcado: false, disponivel: false, motivo: 'conector não embarcado nesta página' });

  // Conector presente, mas sem wallet-mãe do outro lado (alguém abriu a URL direto): init() devolve
  // false, e o motivo precisa dizer isso em vez de alegar que a carteira não está instalada.
  const r = await iniciarConector({ verumConnector: { init: async () => false } } as any);
  assert.equal(r.disponivel, false);
  assert.match(r.motivo!, /sem carteira-mãe/);

  // Conector que explode não pode derrubar o boot da mesa.
  const quebrado = await iniciarConector({ verumConnector: { init: async () => { throw new Error('rede'); } } } as any);
  assert.equal(quebrado.disponivel, false);
  assert.match(quebrado.motivo!, /falhou ao iniciar: rede/);
});
