# Solana Devnet — instruções e estado

## Estado
A integração real com Solana Devnet (conexão da Verum Wallet, Partnership on-chain, funding, escrow, settlement e distribuição) **não está implementada nesta entrega**. O `BlockchainAdapter` da Devnet se declara indisponível (`PendingDevnetAdapter`) — não há código fingindo funcionamento.

## O que já está preparado
- `SOLANA_NETWORK=solana-devnet` aceito pela configuração; `assets` com USDC Devnet oficial da Circle (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimais) e SOL Devnet.
- `SolanaPayQrAdapter` gera URIs `solana:<recipient>?amount=&spl-token=` conforme a especificação oficial do Solana Pay (transfer request).
- Assinaturas Ed25519 verificadas no backend já são as mesmas que uma carteira Solana produz (`signMessage`).

## Próximos passos (fase 13/14/20)
1. Implementar `SolanaDevnetBlockchainAdapter` com RPC `https://api.devnet.solana.com` (consultar saldo/ATA, confirmar transações).
2. ~~Integrar o provider real da Verum Wallet~~ — **feito, pelo caminho que a Verum usa de fato**: a carteira não é extensão que injeta na página, é um PWA que abre as parceiras num iframe (`/dapp-browser?url=…&name=…`) onde o conector **dela** cria `window.verum` por postMessage. O conector está vendorizado em `public/vendor/verum-connector.js` (VerumConnector v9, o mesmo que o portal de swap publica) e `iniciarConector()` o inicia no boot; `public/js/verum-provider.js` normaliza o provider resultante e `selectProvider` continua aceitando somente `id: 'verum-wallet'`. Ligar com `EMBED_ORIGINS` (ver `.env.example`): só então a mesa pode ser enquadrada, os cookies viajam no iframe e `/verum-origins.js` diz ao conector a quem mandar o pedido de assinatura. O que a ponte entrega foi conferido contra o conector real em `test/06-conector-verum.test.ts` (wallet-mãe simulada, assinatura Ed25519 verificada como o servidor verifica). Fora do app da Verum nada muda: `init()` devolve `false`, o Diagnóstico (Perfil → Carteira) diz o motivo e a extensão continua suportada se algum dia existir. `signTransaction` segue fora de escopo — a mesa só assina mensagem.
3. Módulo v2 do contrato (ver ADR-001), implantado apenas na Devnet; `SettlementAdapter` real com `protectedByContract=true` somente quando o endereço de pagamento for o do contrato.
4. Nunca deploy automático em mainnet.
