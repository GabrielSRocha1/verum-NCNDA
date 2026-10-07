/**
 * VerumConnector v9 — ponte da Verum Wallet.
 *
 * Vendorizado do portal de vesting da Verum (verum-vesting-connector.js).
 * v6 trouxe o signAndSendTransaction (VERUM_SIGN_AND_SEND_* + capability
 * 'signAndSendTransaction'): o portal monta a transação SOLANA sem
 * assinaturas e com blockhash placeholder; a carteira troca o blockhash,
 * assina, transmite com broadcaster resiliente e responde a assinatura SÓ
 * após a confirmação on-chain.
 *
 * v7 ADICIONA o pagamento declarativo para as demais redes
 * (VERUM_PAYMENT_* + capability 'signAndSendPayment'): o portal descreve as
 * saídas (endereço, valor em string decimal, ativo) e o memo/tag; a
 * CARTEIRA monta a transação (UTXO no Bitcoin, nonce nas EVM, sequence em
 * XRP/Stellar), exibe no modal, assina, transmite e responde o hash SÓ
 * após a confirmação. O handshake pode declarar `paymentNetworks` para
 * restringir as redes atendidas.
 *
 * v8 EVOLUI o pagamento declarativo para o protocolo v5
 * (docs/PROTOCOLO_TRANSFER_WALLET.md): a requisição carrega `requestId`
 * (correlação da tentativa), `idempotencyKey` (identidade da operação —
 * a MESMA em retries), `fee` (descritor da comissão Verum) e
 * `preferredFeeMode: 'same_transaction'`; a resposta pode declarar
 * `feeMode` (FEE_SAME_TRANSACTION | FEE_SEPARATE_TRANSACTION |
 * CHANGE_NOW_REQUIRED) e `feeTxHash`. Wallet v4 ignora os campos novos e
 * responde só o hash — o portal infere o modo do que pediu. Também muda a
 * semântica de `paymentNetworks`: null = NÃO declarada (compat v4, vale o
 * allowlist do portal); array declarado (mesmo vazio) = SÓ essas redes.
 *
 * v9 TRAZ os endereços por rede (protocolo v6 — `getAddresses`). Sem eles o
 * portal conhece UM endereço, o da chave Solana do login, e o saldo das
 * outras 10 redes (Bitcoin inclusive) aparece como ausente por falta de
 * endereço, não por falta de saldo. São TRÊS canais, do mais barato ao mais
 * caro, e o portal aceita qualquer um:
 *
 *   1. no próprio handshake — `addresses` em VERUM_INIT_RESPONSE ou
 *      VERUM_CONNECT_RESPONSE. É o caminho ideal: conectar JÁ entrega tudo,
 *      sem uma segunda viagem;
 *   2. sob demanda — VERUM_ADDRESSES_REQUEST → VERUM_ADDRESSES_RESPONSE
 *      (a mensagem leva `id` E `requestId` com o mesmo valor; a resposta
 *      pode voltar com qualquer um dos dois);
 *   3. empurrado a qualquer momento — VERUM_ADDRESSES_RESPONSE sem `id`
 *      (rotação de endereço, conta trocada) é aceita e vira o cache.
 *
 * Endereço declarado NÃO é prova de posse — a única prova do fluxo é a
 * assinatura do desafio, que só existe para a rede de login. O backend grava
 * como não verificado e valida formato por rede antes de aceitar.
 *
 * Incluído pelo portal em app/layout.tsx com strategy="beforeInteractive".
 *
 * Contrato consumido por src/lib/verumWallet.ts:
 *   await window.verumConnector.init()   // true se houver provider
 *   window.verum                          // provider (ponte ou injetado)
 *
 * Três ambientes:
 *  1. WebView nativo  → o app injeta window.verum; aqui só expomos a API
 *                       window.verumConnector e repassamos os eventos.
 *  2. Iframe (web)    → NÃO dá para injetar JS cross-origin a partir do app.
 *                       Mas ESTE script roda DENTRO do iframe, então ele mesmo
 *                       define window.verum como um provider-ponte (postMessage)
 *                       com a wallet-pai. É o caminho do PWA — o único que este
 *                       produto usa na prática.
 *  3. Standalone      → sem wallet-pai; não há provider (init() → false).
 *
 * Protocolo postMessage (idêntico ao tratado pelo dapp-browser da wallet):
 *   iframe → pai:  { type, id, origin, ...payload }
 *   pai → iframe:  { type, id, publicKey | signedTransaction(s) | signature | reason }
 *
 * NOTA DE SEGURANÇA — quando o layout injeta `window.__VERUM_WALLET_ORIGINS__`
 * (NEXT_PUBLIC_WALLET_ORIGINS), o envio deixa de usar targetOrigin '*' e o
 * ouvinte descarta mensagens de origens fora da lista. Sem a lista (dev e
 * homologação), vale o comportamento permissivo histórico — e a contenção é o
 * desafio ed25519 do backend: chave afirmada sem assinatura não vira sessão.
 * Em produção a lista DEVE estar configurada, junto com `frame-ancestors` no
 * next.config.mjs restrito à origem da wallet. Ver docs/CHECKLIST_PRODUCAO.md.
 */

(function () {
  'use strict';

  if (window.verumConnector) return;

  var REQUEST_TIMEOUT_MS = 120000;
  // signAndSendTransaction espera modal + broadcast + confirmação on-chain.
  var SIGN_AND_SEND_TIMEOUT_MS = 240000;
  // getAddresses não abre modal e não espera rede: é leitura do que a carteira
  // já tem derivado. O prazo curto existe para que uma wallet-pai que ignora a
  // mensagem não deixe a sincronia de endereços pendurada por dois minutos.
  var ADDRESSES_TIMEOUT_MS = 15000;

  // ─── Estado ───────────────────────────────────────────────────────────────

  var _wallet = null;
  var _publicKey = null;
  var _isConnected = false;
  var _onStatus = null;
  var _cEvents = {};        // eventos do connector ('connected'/'disconnected')
  var _pending = {};        // requests da ponte: id → {resolve, reject, timeout}

  // ─── Utilitários ────────────────────────────────────────────────────────────

  function log(msg, data) {
    if (typeof console !== 'undefined') {
      data !== undefined
        ? console.log('[VerumConnector] ' + msg, data)
        : console.log('[VerumConnector] ' + msg);
    }
  }

  function notifyStatus(status, pk) {
    if (typeof _onStatus === 'function') {
      try { _onStatus(status, pk); } catch (e) { /* não bloqueia */ }
    }
  }

  function emitConnector(ev, data) {
    (_cEvents[ev] || []).forEach(function (cb) { try { cb(data); } catch (e) {} });
  }

  // ID via CSPRNG (Math.random é previsível). Script plain — sem imports do bundle.
  function nextId() {
    var cryptoObj = (typeof window !== 'undefined' ? window.crypto : null) ||
                    (typeof self !== 'undefined' ? self.crypto : null);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var buf = new Uint8Array(8);
      cryptoObj.getRandomValues(buf);
      var hex = '';
      for (var i = 0; i < buf.length; i++) {
        var b = buf[i].toString(16);
        hex += b.length === 1 ? '0' + b : b;
      }
      return 'vc' + hex;
    }
    return 'vc' + Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  function bytesToB64(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var bin = '';
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function b64ToBytes(str) {
    var bin = atob(str);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // base58 → Uint8Array (VerumWalletAdapter faz new PublicKey(publicKey.toBytes())).
  function bs58ToBytes(s) {
    var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var lookup = {};
    for (var i = 0; i < ALPHABET.length; i++) lookup[ALPHABET[i]] = i;
    var bytes = [0];
    for (var i = 0; i < s.length; i++) {
      var c = lookup[s[i]];
      if (c === undefined) throw new Error('Invalid base58 character');
      for (var j = 0; j < bytes.length; j++) {
        c += bytes[j] * 58;
        bytes[j] = c & 0xff;
        c >>= 8;
      }
      while (c > 0) {
        bytes.push(c & 0xff);
        c >>= 8;
      }
    }
    for (var k = 0; s[k] === '1' && k < s.length - 1; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  function makePublicKey(s) {
    return {
      _s: s,
      toString: function () { return this._s; },
      toBase58: function () { return this._s; },
      toJSON:   function () { return this._s; },
      toBytes:  function () { return bs58ToBytes(this._s); },
      equals:   function (o) { return o && (o.toString() === this._s || o === this._s); },
    };
  }

  // Serializa Transaction/VersionedTransaction/Uint8Array → base64 (igual ao nativo).
  function serializeTx(tx) {
    var bytes;
    if (tx instanceof Uint8Array) bytes = tx;
    else if (tx && tx.version !== undefined) bytes = tx.serialize();
    else if (tx && typeof tx.serialize === 'function') bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    else throw new Error('INVALID_PAYLOAD');
    return bytesToB64(bytes);
  }

  function dispatchConnected(pk) {
    try {
      window.dispatchEvent(new CustomEvent('verum#connected', { detail: { publicKey: pk } }));
    } catch (e) {}
  }

  // ─── Detecção de ambiente ────────────────────────────────────────────────────

  var _isWebView = typeof window.ReactNativeWebView !== 'undefined';
  var _isIframe  = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  var _hasInjected = !!(window.verum && window.verum.isVerum) ||
                     !!(window.solana && window.solana.isVerum);
  var _bridgeMode = _isIframe && !_isWebView && !_hasInjected;

  // ─── Origens confiáveis da wallet-pai ────────────────────────────────────────
  // Lista injetada pelo layout a partir de NEXT_PUBLIC_WALLET_ORIGINS. Vazia =>
  // modo permissivo histórico (dev/homologação). Configurada => o envio usa a
  // origem do pai como targetOrigin e o ouvinte ignora quem estiver fora da
  // lista. Wallet antiga que não responda continua apenas dando timeout — o
  // protocolo degrada, não quebra.

  var _allowedOrigins = Array.isArray(window.__VERUM_WALLET_ORIGINS__)
    ? window.__VERUM_WALLET_ORIGINS__.filter(function (o) { return typeof o === 'string' && o.length > 0; })
    : [];

  var _parentOrigin = null;
  (function deriveParentOrigin() {
    if (!_allowedOrigins.length) return;
    if (_allowedOrigins.length === 1) { _parentOrigin = _allowedOrigins[0]; return; }
    // Mais de uma origem permitida: o referrer aponta qual pai nos enquadrou.
    try {
      var ref = document.referrer ? new URL(document.referrer).origin : null;
      if (ref && _allowedOrigins.indexOf(ref) !== -1) { _parentOrigin = ref; return; }
    } catch (e) {}
    _parentOrigin = _allowedOrigins[0];
  })();

  function isTrustedOrigin(origin) {
    if (!_allowedOrigins.length) return true;
    return _allowedOrigins.indexOf(origin) !== -1;
  }

  // ─── Ponte postMessage (iframe) ──────────────────────────────────────────────

  function postToParent(data) {
    try {
      window.parent.postMessage(data, _parentOrigin || '*');
    } catch (e) { log('Falha postMessage', e); }
  }

  /**
   * `mirrorId` repete o id em `requestId`. A spec do getAddresses (§9.1) usa
   * `requestId` enquanto todas as outras mensagens usam `id`; mandar os dois
   * com o MESMO valor deixa a wallet-pai responder pela grafia que ela
   * implementou, e o ouvinte aceita qualquer uma das duas de volta.
   */
  function bridgeRequest(type, payload, timeoutMs, mirrorId) {
    return new Promise(function (resolve, reject) {
      var id = nextId();
      var timeout = setTimeout(function () {
        if (_pending[id]) { delete _pending[id]; reject(new Error('TIMEOUT')); }
      }, timeoutMs || REQUEST_TIMEOUT_MS);
      _pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      var msg = { type: type, id: id, origin: window.location.origin };
      if (mirrorId) msg.requestId = id;
      if (payload) for (var k in payload) if (payload.hasOwnProperty(k)) msg[k] = payload[k];
      postToParent(msg);
    });
  }

  // Correlação e liquidação única: cada request vive em _pending até a
  // PRIMEIRA resposta com o mesmo id (ou o timeout). Resposta duplicada,
  // atrasada ou com id desconhecido não encontra pending e é descartada —
  // é a garantia de que uma mesma operação nunca liquida duas vezes.
  function settleBridge(id, value, error) {
    var p = _pending[id];
    if (!p) return;
    clearTimeout(p.timeout);
    delete _pending[id];
    error ? p.reject(error) : p.resolve(value);
  }

  // ─── Provider-ponte (window.verum no iframe) ─────────────────────────────────

  function buildBridgeProvider() {
    return {
      isVerum: true,
      isPhantom: true,
      isConnected: false,
      connected: false,
      publicKey: null,
      network: 'mainnet',
      // Preenchida pelo handshake (VERUM_INIT/CONNECT_RESPONSE.capabilities).
      // Vazia = wallet-pai antiga: o portal degrada para o caminho
      // estruturado (sem envio automático), sem timeout e sem erro.
      capabilities: [],
      // Redes atendidas pelo signAndSendPayment. null = o handshake NÃO
      // declarou (wallet v4; vale o allowlist do portal — semântica de
      // compatibilidade documentada). Array declarado, MESMO VAZIO, é a
      // lista exata: vazio = nenhuma rede. Nunca se assume "todas".
      paymentNetworks: null,
      // Endereços por rede (protocolo v6). null = a wallet-pai nunca declarou
      // nada; array (mesmo vazio) = declaração dela. A distinção importa:
      // declarar lista vazia é dizer "não tenho o que declarar", e isso é
      // resposta — não motivo para perguntar de novo a cada carregamento.
      addresses: null,
      _events: {},

      on: function (e, cb) { (this._events[e] || (this._events[e] = [])).push(cb); return this; },
      off: function (e, cb) {
        if (this._events[e]) this._events[e] = this._events[e].filter(function (f) { return f !== cb; });
        return this;
      },
      emit: function (e, d) {
        (this._events[e] || []).forEach(function (cb) { try { cb(d); } catch (err) {} });
      },

      __setConnected: function (pkStr) {
        this.connected = true;
        this.isConnected = true;
        this.publicKey = makePublicKey(pkStr);
        this.emit('connect', this.publicKey);
        this.emit('accountChanged', this.publicKey);
      },

      __setCapabilities: function (caps) {
        this.capabilities = Array.isArray(caps)
          ? caps.filter(function (c) { return typeof c === 'string'; })
          : [];
      },

      /**
       * Guarda o que a wallet-pai declarou por rede. Só entrada com `network`
       * e `address` em texto entra — o resto é descartado aqui, e a validação
       * que vale (formato por rede, allowlist) é a do backend, que é quem
       * grava. Payload que não é array não vira declaração: continuaria null,
       * e null é o que autoriza perguntar de novo.
       */
      __setAddresses: function (list) {
        if (!Array.isArray(list)) return;
        this.addresses = list.filter(function (entry) {
          return entry && typeof entry.network === 'string' && typeof entry.address === 'string';
        });
        this.emit('addressesChanged', this.addresses);
      },

      __setPaymentNetworks: function (networks) {
        // Só o handshake que DECLAROU a lista a torna autoritativa; payload
        // malformado não vira declaração (permaneceria null = compat v4).
        this.paymentNetworks = Array.isArray(networks)
          ? networks.filter(function (n) { return typeof n === 'string'; })
          : null;
      },

      connect: function () {
        var self = this;
        if (self.connected && self.publicKey) return Promise.resolve({ publicKey: self.publicKey });
        return bridgeRequest('VERUM_CONNECT_REQUEST').then(function () {
          return { publicKey: self.publicKey };
        });
      },

      disconnect: function () {
        postToParent({ type: 'VERUM_DISCONNECT', origin: window.location.origin });
        this.connected = false;
        this.isConnected = false;
        this.publicKey = null;
        this.emit('disconnect');
        return Promise.resolve();
      },

      signTransaction: function (tx) {
        return bridgeRequest('VERUM_SIGN_TX_REQUEST', { transaction: serializeTx(tx) })
          .then(function (b64) { return b64ToBytes(b64); });
      },

      signAllTransactions: function (txs) {
        return bridgeRequest('VERUM_SIGN_ALL_REQUEST', { transactions: txs.map(serializeTx) })
          .then(function (arr) { return arr.map(function (b) { return b64ToBytes(b); }); });
      },

      signMessage: function (message) {
        return bridgeRequest('VERUM_SIGN_MSG_REQUEST', { message: bytesToB64(message) })
          .then(function (r) { return { signature: b64ToBytes(r.signature), publicKey: r.publicKey }; });
      },

      /**
       * getAddresses (spec v6, §9.1: docs/PROTOCOLO_TRANSFER_WALLET.md).
       *
       * Devolve os endereços PÚBLICOS de recebimento que a carteira controla
       * em cada rede. Não abre modal, não assina nada e não é prova de posse —
       * é o que destrava o saldo das redes que não são a do login (o BTC
       * aparecia como "sem endereço" justamente por falta deste passo).
       *
       * Três desfechos, e nenhum deles trava a tela: cache do handshake
       * (resposta imediata), resposta da wallet-pai, ou recusa/prazo curto —
       * e recusa vira lista vazia lá em cima, nunca erro de conexão.
       */
      getAddresses: function () {
        var self = this;
        if (Array.isArray(self.addresses)) return Promise.resolve({ addresses: self.addresses });
        // Capabilities DECLARADAS sem 'getAddresses' = wallet-pai que não
        // conhece a mensagem; esperar o prazo inteiro por uma resposta que
        // não vem só atrasaria a sincronia. Lista VAZIA é handshake anterior
        // à declaração de capacidades — aí vale tentar, o custo é o prazo curto.
        if (self.capabilities && self.capabilities.length &&
            self.capabilities.indexOf('getAddresses') === -1) {
          return Promise.reject(new Error('UNSUPPORTED'));
        }
        return bridgeRequest('VERUM_ADDRESSES_REQUEST', null, ADDRESSES_TIMEOUT_MS, true)
          .then(function (list) {
            // Responde o que FOI GUARDADO, não o que chegou: o filtro de
            // forma mora no __setAddresses, e devolver o payload cru abriria
            // uma segunda porta, sem filtro, para a mesma declaração.
            self.__setAddresses(list);
            return { addresses: Array.isArray(self.addresses) ? self.addresses : [] };
          });
      },

      /**
       * signAndSendTransaction (spec v3: docs/PROTOCOLO_TRANSFER_WALLET.md).
       * O portal monta a transação (sem assinaturas, blockhash placeholder);
       * a wallet-pai troca o blockhash, exibe o modal, assina, transmite e
       * responde a assinatura SÓ após confirmar on-chain — por isso o prazo
       * maior (240 s). Sem a capability declarada no handshake, recusa na
       * hora — nunca deixa a página esperando por uma wallet-pai que não
       * conhece a mensagem.
       */
      signAndSendTransaction: function (tx) {
        if (!this.capabilities || this.capabilities.indexOf('signAndSendTransaction') === -1) {
          return Promise.reject(new Error('UNSUPPORTED'));
        }
        return bridgeRequest(
          'VERUM_SIGN_AND_SEND_REQUEST',
          { transaction: serializeTx(tx) },
          SIGN_AND_SEND_TIMEOUT_MS
        );
      },

      /**
       * signAndSendPayment (spec v4/v5: docs/PROTOCOLO_TRANSFER_WALLET.md).
       * Pagamento declarativo para redes não-Solana: o portal descreve as
       * saídas (valores em STRING decimal) e o memo/tag; a wallet-pai monta
       * a transação da rede, exibe o modal, assina, transmite e responde o
       * hash SÓ após confirmar on-chain — mesmo prazo maior (240 s). Sem a
       * capability, recusa na hora. `paymentNetworks` DECLARADA restringe às
       * redes listadas (vazia = nenhuma); null (não declarada) mantém a
       * compatibilidade v4 e deixa a decisão para o allowlist do portal.
       *
       * v5: `requestId`, `idempotencyKey`, `fee` e `preferredFeeMode` seguem
       * na mensagem quando o portal os informa. A carteira v4 os ignora; a
       * v5 responde `feeMode`/`feeTxHash`. A comissão NUNCA leva a carteira
       * a inventar uma saída extra: `fee` é informativo — as saídas
       * autorizadas são SEMPRE e SOMENTE `payment.outputs`.
       */
      signAndSendPayment: function (request) {
        if (!this.capabilities || this.capabilities.indexOf('signAndSendPayment') === -1) {
          return Promise.reject(new Error('UNSUPPORTED'));
        }
        if (Array.isArray(this.paymentNetworks) &&
            this.paymentNetworks.indexOf(request.network) === -1) {
          return Promise.reject(new Error('UNSUPPORTED'));
        }
        var payload = {
          network: request.network,
          payment: { outputs: request.outputs, memo: request.memo },
        };
        if (typeof request.requestId === 'string') payload.requestId = request.requestId;
        if (typeof request.idempotencyKey === 'string') payload.idempotencyKey = request.idempotencyKey;
        if (request.fee && typeof request.fee === 'object') payload.fee = request.fee;
        if (typeof request.preferredFeeMode === 'string') payload.preferredFeeMode = request.preferredFeeMode;
        return bridgeRequest('VERUM_PAYMENT_REQUEST', payload, SIGN_AND_SEND_TIMEOUT_MS);
      },
    };
  }

  if (_bridgeMode) {
    var bridge = buildBridgeProvider();
    window.verum = bridge;
    if (!window.solana) window.solana = bridge;

    window.addEventListener('message', function (e) {
      // Origem fora da lista confiável: descarte silencioso. Sem lista
      // configurada, isTrustedOrigin devolve true (comportamento histórico).
      if (!isTrustedOrigin(e.origin)) return;
      if (_allowedOrigins.length) _parentOrigin = e.origin;
      var d = e.data;
      if (!d || typeof d !== 'object' || !d.type) return;

      switch (d.type) {
        case 'VERUM_CONNECT_RESPONSE':
        case 'VERUM_INIT_RESPONSE':
          // Capacidades chegam mesmo sem sessão ativa (INIT sem publicKey).
          if (d.capabilities) bridge.__setCapabilities(d.capabilities);
          if (d.paymentNetworks) bridge.__setPaymentNetworks(d.paymentNetworks);
          // Endereços por rede no PRÓPRIO handshake: conectar já entrega o
          // que o saldo das 10 redes não-Solana precisa, sem segunda viagem.
          if (d.addresses) bridge.__setAddresses(d.addresses);
          if (d.publicKey) {
            bridge.__setConnected(d.publicKey);
            if (d.id) settleBridge(d.id, { publicKey: d.publicKey });
            _publicKey = d.publicKey; _isConnected = true;
            notifyStatus('connected', d.publicKey);
            emitConnector('connected', d.publicKey);
            dispatchConnected(d.publicKey);
          }
          break;

        case 'VERUM_CONNECT_REJECTED':
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'USER_REJECTED'));
          break;

        case 'VERUM_ADDRESSES_RESPONSE':
          // Vira cache SEMPRE, com ou sem correlação: a mesma mensagem serve
          // de resposta ao pedido e de empurrão quando a carteira roda o
          // endereço ou troca de conta.
          var declaredList = Array.isArray(d.addresses) ? d.addresses : [];
          bridge.__setAddresses(declaredList);
          var declaredId = d.id || d.requestId;
          if (declaredId) settleBridge(declaredId, declaredList);
          break;
        case 'VERUM_ADDRESSES_REJECTED':
          var rejectedId = d.id || d.requestId;
          if (rejectedId) settleBridge(rejectedId, null, new Error(d.reason || 'UNSUPPORTED'));
          break;

        case 'VERUM_SIGN_TX_RESPONSE':
          if (d.id) settleBridge(d.id, d.signedTransaction);
          break;
        case 'VERUM_SIGN_TX_REJECTED':
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'USER_REJECTED'));
          break;

        case 'VERUM_SIGN_ALL_RESPONSE':
          if (d.id) settleBridge(d.id, d.signedTransactions);
          break;
        case 'VERUM_SIGN_ALL_REJECTED':
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'USER_REJECTED'));
          break;

        case 'VERUM_SIGN_MSG_RESPONSE':
          if (d.id) settleBridge(d.id, { signature: d.signature, publicKey: d.publicKey });
          break;
        case 'VERUM_SIGN_MSG_REJECTED':
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'USER_REJECTED'));
          break;

        case 'VERUM_SIGN_AND_SEND_RESPONSE':
          // Em Solana a assinatura E o identificador: aceita as duas grafias.
          // So uma delas aqui e uma wallet que responda a outra viraria
          // "falhou" com a transacao JA confirmada — e o caminho manual
          // sugerido induziria um segundo deposito.
          if (d.id) settleBridge(d.id, { signature: d.signature || d.txHash });
          break;
        case 'VERUM_SIGN_AND_SEND_REJECTED':
          // reason: USER_REJECTED | UNSUPPORTED | INSUFFICIENT_FUNDS | FAILED
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'FAILED'));
          break;

        case 'VERUM_PAYMENT_RESPONSE':
          // Hash da transação que a wallet montou e transmitiu. Aceita
          // também a grafia signature — a mesma tolerância do fluxo Solana:
          // recusar a grafia certa da wallet viraria "falhou" com a tx JÁ
          // confirmada e induziria pagamento em dobro. Campos v5 (feeMode e
          // feeTxHash) seguem adiante quando declarados; resposta DUPLICADA
          // ou atrasada é descartada pelo settleBridge (o pending já saiu do
          // mapa na primeira resposta) — nunca liquida duas vezes.
          if (d.id) {
            settleBridge(d.id, {
              txHash: d.txHash || d.signature,
              feeMode: typeof d.feeMode === 'string' ? d.feeMode : null,
              feeTxHash: typeof d.feeTxHash === 'string' ? d.feeTxHash : null,
            });
          }
          break;
        case 'VERUM_PAYMENT_REJECTED':
          // reason: USER_REJECTED | UNSUPPORTED | INSUFFICIENT_FUNDS |
          // FAILED | CHANGE_NOW_REQUIRED (v5: a coleta da fee segue pelo
          // programa de afiliados ChangeNOW — o portal resolve o degrau).
          if (d.id) settleBridge(d.id, null, new Error(d.reason || 'FAILED'));
          break;
      }
    });

    // Handshake: pergunta ao pai se já existe sessão ativa (fast connect).
    postToParent({ type: 'VERUM_INIT_REQUEST', origin: window.location.origin });
  }

  // ─── Resolução do provider ────────────────────────────────────────────────────

  function resolveProvider() {
    if (window.verum && window.verum.isVerum) return window.verum;
    if (window.solana && window.solana.isVerum) return window.solana;
    return null;
  }

  // ─── API pública window.verumConnector ────────────────────────────────────────

  var connector = {
    get publicKey()   { return _publicKey;   },
    get isConnected() { return _isConnected; },
    get wallet()      { return _wallet;      },

    on: function (event, cb) {
      (_cEvents[event] || (_cEvents[event] = [])).push(cb);
      return connector;
    },
    off: function (event, cb) {
      if (_cEvents[event]) _cEvents[event] = _cEvents[event].filter(function (f) { return f !== cb; });
      return connector;
    },

    init: async function (onStatusChange) {
      _onStatus = onStatusChange || null;
      log('Inicializando...', { bridgeMode: _bridgeMode, hasInjected: _hasInjected });

      var provider = resolveProvider();
      if (!provider) { log('Verum Wallet não detectada neste ambiente.'); return false; }
      _wallet = provider;

      // Já conectado (sessão ativa / push do pai) — avisa o portal.
      if (provider.connected && provider.publicKey) {
        _publicKey = provider.publicKey.toString();
        _isConnected = true;
        notifyStatus('connected', _publicKey);
        emitConnector('connected', _publicKey);
      }

      // Eventos do provider injetado/ponte.
      if (typeof provider.on === 'function') {
        provider.on('connect', function (pk) {
          _publicKey = pk ? pk.toString() : null; _isConnected = true;
          notifyStatus('connected', _publicKey);
          emitConnector('connected', _publicKey);
        });
        provider.on('disconnect', function () {
          _publicKey = null; _isConnected = false;
          notifyStatus('disconnected', null);
          emitConnector('disconnected', null);
        });
        provider.on('accountChanged', function (pk) {
          _publicKey = pk ? pk.toString() : null;
          notifyStatus('connected', _publicKey);
          emitConnector('connected', _publicKey);
        });
      }

      window.addEventListener('verum#connected', function (e) {
        if (e.detail && e.detail.publicKey) {
          _publicKey = e.detail.publicKey; _isConnected = true;
          notifyStatus('connected', _publicKey);
          emitConnector('connected', _publicKey);
        }
      });

      return true;
    },

    connect: async function () {
      if (!_wallet) _wallet = resolveProvider();
      if (!_wallet) throw new Error('Wallet não inicializada.');
      if (_isConnected && _publicKey) return _publicKey;

      var resp = await _wallet.connect();
      var pk = resp && resp.publicKey ? resp.publicKey.toString() : null;
      if (pk) { _publicKey = pk; _isConnected = true; notifyStatus('connected', pk); emitConnector('connected', pk); }
      return pk;
    },

    disconnect: async function () {
      if (_wallet) { try { await _wallet.disconnect(); } catch (e) {} }
      _publicKey = null; _isConnected = false;
      notifyStatus('disconnected', null);
      emitConnector('disconnected', null);
    },
  };

  window.verumConnector = connector;
  log('Pronto.');
})();
