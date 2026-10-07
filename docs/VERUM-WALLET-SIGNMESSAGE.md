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

## Enquanto isso

A mesa não finge que entrou. Dentro do app da Verum ela diz, antes do clique, que a carteira não
declarou assinatura de mensagem, oferece a carteira DEMO para seguir a demonstração e guarda um
"tentar mesmo assim" — porque a trava é pelo que a wallet **declara**, e no dia em que ela passar a
assinar a conferência é imediata, sem depender de nova versão da mesa.
