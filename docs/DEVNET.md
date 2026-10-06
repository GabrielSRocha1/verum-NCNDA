# Solana Devnet — instruções e estado

## Estado
A integração real com Solana Devnet (conexão da Verum Wallet, Partnership on-chain, funding, escrow, settlement e distribuição) **não está implementada nesta entrega**. O `BlockchainAdapter` da Devnet se declara indisponível (`PendingDevnetAdapter`) — não há código fingindo funcionamento.

## O que já está preparado
- `SOLANA_NETWORK=solana-devnet` aceito pela configuração; `assets` com USDC Devnet oficial da Circle (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimais) e SOL Devnet.
- `SolanaPayQrAdapter` gera URIs `solana:<recipient>?amount=&spl-token=` conforme a especificação oficial do Solana Pay (transfer request).
- Assinaturas Ed25519 verificadas no backend já são as mesmas que uma carteira Solana produz (`signMessage`).

## Próximos passos (fase 13/14/20)
1. Implementar `SolanaDevnetBlockchainAdapter` com RPC `https://api.devnet.solana.com` (consultar saldo/ATA, confirmar transações).
2. Integrar o provider real da Verum Wallet quando a Verum publicar a API web (`connect`, `signMessage`, `signTransaction`); manter `selectProvider` aceitando somente esse provider.
3. Módulo v2 do contrato (ver ADR-001), implantado apenas na Devnet; `SettlementAdapter` real com `protectedByContract=true` somente quando o endereço de pagamento for o do contrato.
4. Nunca deploy automático em mainnet.
