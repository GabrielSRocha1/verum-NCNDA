# Checklist de segurança — estado nesta entrega

| Item | Estado |
|---|---|
| Validação de input por JSON Schema, `additionalProperties:false`, sem `removeAdditional` | Feito |
| Autenticação sem senha por assinatura Ed25519 (challenge+nonce, 2 min, uso único, anti-replay) | Feito (testes 10, 11, 17) |
| Autorização por operação (admin ou membro com convite concluído); RBAC para convites/linhas/settlement | Feito (testes 20, 0/16) |
| Rate limit em open, resume, verify-code, wallet-challenge/verify, login | Feito (teste 18) |
| Proteção contra manipulação de percentuais/carteira: triggers no banco + nova versão | Feito (testes LOCKED) |
| Validação de assets (rede+mint+decimals, lookalike bloqueado, mainnet desligada) | Feito (teste 14) |
| Nenhum segredo no frontend; nenhuma private key no backend (DEMO: sementes públicas, documentado) | Feito |
| Headers: CSP sem unsafe-inline, nosniff, no-referrer, X-Frame-Options DENY, COOP, Permissions-Policy, HSTS quando Secure | Feito |
| Sanitização de saída: DOM construído por `textContent` (sem innerHTML com dados) | Feito |
| Comparação em tempo constante do código do convite; só hashes no banco; token redigido em log | Feito (testes 1, 19) |
| Cookies httpOnly/Secure/SameSite=Strict; sessão curta renovável com limite absoluto | Feito |
| Auditoria somente-inclusão sem dado pessoal | Feito (teste 19) |
| Segredos obrigatórios fora do DEMO (`SESSION_SECRET`, `INVITE_PEPPER` ≥ 32 chars) | Feito |
| Atestação do software da carteira | **Não existe** — não afirmado na UI |
| Integração Devnet real, contrato N participantes, auditoria externa | **Pendente** (fases 13–16) |

Pré-requisitos antes de mainnet: adapters reais (Solana Devnet), módulo v2 do contrato com testes de invariantes/fuzz, revisão de segurança, auditoria independente e autorização explícita do responsável.
