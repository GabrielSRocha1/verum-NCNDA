# Pedido ao time da Verum Wallet: `signMessage` no dapp-browser

**Resumo:** a mesa VERUM NCNDA abre corretamente dentro do dapp-browser da Verum Wallet e **conecta**
— mas não consegue autenticar ninguém, porque a wallet-mãe não atende `VERUM_SIGN_MSG_REQUEST` nem
declara `signMessage` entre as suas capacidades. A mesa entra **somente** por assinatura de mensagem
(é assim que ela prova a posse da carteira sem senha), então hoje ela é inutilizável ali.

Documento escrito a partir do conector publicado pela própria Verum
(`swap.verumcrypto.com/swap-freeport-connector.js`, "VerumConnector v9"), vendorizado nesta mesa em
`public/vendor/verum-connector.js`.

---

## O que funciona hoje

| Etapa | Resultado |
|---|---|
| Enquadrar a mesa no iframe (`/dapp-browser?url=…`) | ✅ |
| `verumConnector.init()` → `window.verum` criado | ✅ |
| Handshake `VERUM_INIT_REQUEST` → `VERUM_INIT_RESPONSE` | ✅ |
| `VERUM_CONNECT_REQUEST` → endereço devolvido | ✅ (a barra da wallet mostra CONECTADA) |
| `VERUM_SIGN_MSG_REQUEST` | ❌ **sem resposta** — nem `_RESPONSE`, nem `_REJECTED` |

## Evidência

1. **O que a wallet declara no handshake** (lido na tela de diagnóstico da mesa, dentro do app):

   ```
   transfer · multiTransfer · addresses · signAndSendTransaction · sendTransaction · signAndSendPayment
   ```

   Sem `signMessage`.

2. **Comportamento observado antes de a mesa travar por capacidade:** três tentativas em 2026-10-07
   geraram desafio no servidor da mesa e **nenhuma** foi consumida. Como o servidor consome o desafio
   mesmo quando a assinatura é inválida, "não consumido" significa que a resposta nunca chegou — a
   requisição ficou pendente até o `REQUEST_TIMEOUT_MS` de 120 s do conector.

## O que a mesa envia e o que espera de volta

Exatamente o que o conector de vocês define (`bridgeRequest('VERUM_SIGN_MSG_REQUEST', …)`):

```jsonc
// dApp → wallet (postMessage para a origem da wallet)
{ "type": "VERUM_SIGN_MSG_REQUEST",
  "id": "<id da requisição>",
  "origin": "https://verum-ncnda.vercel.app",
  "message": "<bytes da mensagem em base64>" }
```

```jsonc
// wallet → dApp, caminho feliz
{ "type": "VERUM_SIGN_MSG_RESPONSE",
  "id": "<mesmo id>",
  "signature": "<Ed25519 detached, 64 bytes, em base64>",
  "publicKey": "<base58>" }

// wallet → dApp, quando a pessoa recusa
{ "type": "VERUM_SIGN_MSG_REJECTED", "id": "<mesmo id>", "reason": "USER_REJECTED" }
```

E declarar `signMessage` em `capabilities`, no `VERUM_INIT_RESPONSE` e no `VERUM_CONNECT_RESPONSE`.

**A mensagem é texto puro e nunca é transação.** Ela nomeia o domínio, a ação e um nonce de uso
único; não toca em saldo, não tem instrução e não custa taxa. Exemplo real:

```
VERUM NCNDA
Acao: ENTRAR
Dominio: verum-ncnda.vercel.app
Nonce: 7xKq…
```

## Um segundo achado, interno de vocês

O conector condiciona `getAddresses()` à capacidade **`getAddresses`**:

```js
if (self.capabilities && self.capabilities.length &&
    self.capabilities.indexOf('getAddresses') === -1) {
  return Promise.reject(new Error('UNSUPPORTED'));
}
```

A wallet declara **`addresses`**. Com esses dois artefatos conversando, `getAddresses()` responde
`UNSUPPORTED` sempre — mesmo com a wallet sabendo fazer. Vale conferir o vocabulário de capacidades
entre conector e wallet; `signAndSendTransaction` e `signAndSendPayment` batem, `addresses` não.

## Atualização 2026-10-07, 18h: a janela passou a aparecer, a resposta não chega

Depois de um ajuste do lado de vocês, a carteira EXIBE a janela de assinatura e a pessoa assina —
mas a mesa continua esperando. O contexto dela não se perdeu (o sheet segue aberto, com a mensagem
original à vista), então a resposta ou não foi postada, ou foi postada de um jeito que o conector
descarta em silêncio. Os dois descartes silenciosos possíveis, no código de vocês:

1. **Casamento por `id`.** O ouvinte faz:

   ```js
   case 'VERUM_SIGN_MSG_RESPONSE':
     if (d.id) settleBridge(d.id, { signature: d.signature, publicKey: d.publicKey });
   ```

   Resposta sem `id` — ou com `requestId`, a outra grafia que o próprio conector documenta no
   getAddresses (§9.1) — não resolve nada: a promessa fica pendurada até os 120 s e a pessoa vê a
   mesa parada depois de ter assinado.

2. **Origem.** `isTrustedOrigin(e.origin)` descarta **sem aviso** o que vier de origem fora da lista
   injetada em `window.__VERUM_WALLET_ORIGINS__`. Se a janela de assinatura responde de uma origem
   diferente da que enquadra o iframe, a resposta morre aí.

Para não depender disso, a mesa passou a aceitar também a resposta que chega com `requestId` ou com
o tipo por extenso (`VERUM_SIGN_MESSAGE_RESPONSE`), sempre da origem confiável e só enquanto há
pedido em curso — a assinatura em si continua sendo verificada pelo servidor contra o nonce que ele
emitiu, então afrouxar o casamento não afrouxa a segurança. **Ainda assim vale corrigir no conector
ou na wallet**, porque qualquer outra parceira que use o conector de vocês vai bater no mesmo ponto.

A mesa também passou a registrar a FORMA de tudo que chega por postMessage (origem, tipo e nomes
dos campos — nunca o conteúdo) e a mostrar no diagnóstico. Se ainda não funcionar, esse print diz
em qual dos dois casos acima estamos, ou se a resposta não chegou de todo.

## Enquanto isso

A mesa não finge que entrou. Dentro do app da Verum ela diz, antes do clique, que a carteira não
declarou assinatura de mensagem, oferece a carteira DEMO para seguir a demonstração e guarda um
"tentar mesmo assim" — porque a trava é pelo que a wallet **declara**, e no dia em que ela passar a
assinar a conferência é imediata, sem depender de nova versão da mesa.
