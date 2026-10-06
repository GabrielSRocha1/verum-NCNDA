# ADR-001 — Distribuição para N participantes como módulo novo e versionado

**Status:** aceito (preparação) · **Data:** 2026-10-05

## Contexto
O monorepo on-chain v1.0.0 existente (Anchor/Solana, Solidity EVM, Tron) trabalha com exatamente 4 participantes fixos (Vendedor, Comprador, Pay Master 01, Pay Master 02) e não pode ser alterado.
A Deal Room precisa registrar parcerias com N participantes (até 7 funções + 2 Pay Masters) e linhas de comissão em bps com resíduo explícito.

## Decisão
1. O monorepo v1.0.0 fica intocado.
2. A distribuição N-de-N nasce como **módulo novo e versionado** (`partnership-distribution/v2`), com interface definida off-chain nesta entrega (`SettlementAdapter` + `distribute()` em `src/lib/bps.ts`) e invariantes que o contrato deverá reproduzir:
   - soma(bps) == deságio total (X·100); soma(valores) == pool = floor(ref·X·100/10000);
   - resíduo de unidades vai integralmente ao destinatário da `residual_policy`, em linha própria;
   - fração abaixo da unidade mínima é truncada e reportada, nunca distribuída em silêncio;
   - nenhuma alteração após LOCKED: mudança = nova versão com novo `terms_hash` e N novas assinaturas.
3. O Partnership ID on-chain = `terms_hash` da versão LOCKED; participantes, carteiras e bps são gravados como dados da conta/estado do contrato, e o backend nunca assina transações.
4. Até o contrato existir, o único adapter é `DEMO_SIMULATED`, e a UI exibe "PAGAMENTO DIRETO — fora do escrow", nunca selo de proteção.

## Consequências
- Compatibilidade preservada com v1.0.0 (4 participantes) e caminho claro para v2 (N participantes).
- O módulo v2 só vai para mainnet após testes unitários, integração, fuzz, invariantes, autorização, overflow/underflow, reentrancy, revisão de segurança e auditoria independente. Testes passando não significam "seguro".
