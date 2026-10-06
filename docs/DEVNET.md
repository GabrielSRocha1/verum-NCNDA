# Solana Devnet — instruções e estado

## Estado
A integração real com Solana Devnet (conexão da Verum Wallet, Partnership on-chain, funding, escrow, settlement e distribuição) **não está implementada nesta entrega**. O `BlockchainAdapter` da Devnet se declara indisponível (`PendingDevnetAdapter`) — não há código fingindo funcionamento.

## O que já está preparado
- `SOLANA_NETWORK=solana-devnet` aceito pela configuração; `assets` com USDC Devnet oficial da Circle (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimais) e SOL Devnet.
- `SolanaPayQrAdapter` gera URIs `solana:<recipient>?amount=&spl-token=` conforme a especificação oficial do Solana Pay (transfer request).
- Assinaturas Ed25519 verificadas no backend já são as mesmas que uma carteira Solana produz (`signMessage`).

## Próximos passos (fase 13/14/20)
1. Implementar `SolanaDevnetBlockchainAdapter` com RPC `https://api.devnet.solana.com` (consultar saldo/ATA, confirmar transações).
2. ~~Integrar o provider real da Verum Wallet~~ — a ponte existe: `public/js/verum-provider.js` detecta a extensão (`window.verum` e variantes), aceita `connect`/`enable`/`requestAccounts` e `signMessage` assíncronos, e normaliza assinatura em bytes ou base58. `selectProvider` continua aceitando somente `id: 'verum-wallet'` com `isVerumWallet === true`. Falta confirmar a forma real contra a extensão publicada: o Diagnóstico (Perfil → Carteira) mostra o que o navegador expõe, e forma não reconhecida **não** vira provider adivinhado. `signTransaction` segue fora de escopo — a mesa só assina mensagem.
3. Módulo v2 do contrato (ver ADR-001), implantado apenas na Devnet; `SettlementAdapter` real com `protectedByContract=true` somente quando o endereço de pagamento for o do contrato.
4. Nunca deploy automático em mainnet.
