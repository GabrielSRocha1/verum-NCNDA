# Arquitetura — VERUM NCNDA PRIVATE DAPP

## Cadeia de participantes
VENDEDOR → GRUPO VENDA → INTERMEDIAÇÃO VENDA → PAY MASTER/LIGAÇÃO → INTERMEDIAÇÃO COMPRA → GRUPO COMPRA → COMPRADOR

Cada operação (`deals`) tem uma oferta (`offers`, ÚNICA ou PERMANENTE via `businesses`), duas pernas (`offer_legs`: ENTREGA/RECEBIMENTO com `leg_type`), uma parceria (`partnerships`) com versões (`partnership_versions`), cadeiras (`partnership_participants`: função + seq + usuário + carteira) e linhas de comissão (`allocation_lines`, bps inteiros).

## Estados da versão da parceria
DRAFT → PENDING_SIGNATURES → LOCKED → FUNDED → EXECUTING → SETTLED (+ EXPIRED, CANCELLED). PENDING → DRAFT invalida assinaturas. LOCKED → nova versão (clone em DRAFT, `supersedes_id`/`superseded_by_id`). Transições e invariantes são validadas por trigger (`002_guards.sql`).

## Hash dos termos
`terms_hash = SHA-256(JSON canônico {deal, versão, oferta, pernas, grade, política de resíduo, participantes+carteiras, linhas})`. Gerado ao enviar para assinatura; entra na mensagem SIGNATURE OF AGREEMENT; LOCKED exige N assinaturas válidas com o mesmo hash.

## Assinaturas (sempre de mensagem, nunca transação)
`wallet_challenges` guarda apenas `nonce_hash`; o servidor reconstrói a mensagem a partir do registro + nonce enviado pelo cliente e verifica Ed25519 com a chave pública (endereço). Challenge: 2 min, uso único (consumido mesmo se a assinatura falhar), finalidade (INVITE/LOGIN/AGREEMENT/DOCUMENT/SETTLEMENT) e contexto fixos.

## Convite de acesso único
Token 256 bits (só hash no banco) + código VOTC (HMAC com pepper, comparação em tempo constante, 5 tentativas → BLOQUEADO). GET/HEAD do link nunca consomem; `POST /invite/open` consome e vincula ao navegador por cookie assinado (`opened_session_hash`). Prazo de conclusão = max(RESUME_WINDOW, ONBOARDING_TTL) limitado à validade; varredura marca EXPIRADO; nunca volta a ATIVO.

## Privacidade
Contatos (telefone/e-mail) só para membros da operação (`deal_participants`), visíveis apenas de participantes com convite concluído. Visitante em onboarding vê nome e função com contatos mascarados. Auditoria não grava token, código, nome, e-mail nem telefone (filtro `FORBIDDEN_KEYS` em `lib/common.ts`); URLs do convite são redigidas no log.

## Adapters (injeção de dependência)
- `SignatureAdapter` (Solana/Ed25519) · `AssetAdapter` (registry: rede+mint+decimals, lookalike bloqueado, mainnet desligada)
- `QrPayloadAdapter` (Solana Pay transfer request para devnet/mainnet; DEMO só endereço+rótulo; outras redes endereço puro)
- `SettlementAdapter` (DEMO_SIMULATED: `protectedByContract=false`) · `BlockchainAdapter` (DEMO disponível; Devnet declarado indisponível)

## Multi-rede
Primeira implementação Solana + Verum Wallet. Ethereum/BNB/Polygon/Arbitrum/Tron/Bitcoin entram como novas implementações dos adapters, sem alterar domínio ou schema (`wallets.network`, `assets.network`).
