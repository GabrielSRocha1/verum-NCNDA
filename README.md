# VERUM NCNDA PRIVATE DAPP

Deal Room privada + Partnership Management + DApp para organizar operações OTC entre grupos fechados, com regras de comissão travadas antes da execução.

**Estado desta entrega: DEMO / TESTNET — NO REAL FUNDS.** Não é exchange, corretora nem marketplace. Sem custódia. Sem cadastro público. Mainnet desligada e recusada na inicialização.

## Rodar em 2 minutos

Requisitos: Node.js 22.18+ (executa TypeScript nativamente; não há etapa de build). O banco é um PostgreSQL 18 embarcado (PGlite), criado automaticamente em `./data/pgdata`.

```bash
npm install
cp .env.example .env        # ajuste COOKIE_SECURE=false para http://localhost
npm start                   # http://localhost:8787
npm test                    # 40 testes (motor de comissões, onboarding 3.9, parceria/banco/settlement)
npm run db:reset            # apaga o banco local; o próximo "npm start" recria o DEMO
```

Entre como **Rafael Monteiro** (Pay Master 01, admin das mesas DEMO). As outras personas são os parceiros das mesas. Para ver a mesa pelo olhar de um parceiro, saia e entre como outra persona.

## O que há no DEMO

| Mesa | Tipo | Direção | Grade | Estado inicial |
|---|---|---|---|---|
| OTC-0001 | OFERTA ÚNICA | BTC → USDT | 7/4 | DRAFT — cadeira de Intermediação Compra aguardando convite |
| OTC-0002 | PARCERIA PERMANENTE (Aurora Commodities) | Ativo físico → USDT | 25/15 | PARTNERSHIP LOCKED 7/7 (assinaturas Ed25519 reais) |
| OTC-0003 | OFERTA ÚNICA, 2 Pay Masters | Ativo físico → USDT | 12/8 | Aguardando aceites 5/6 |

Roteiro de aceitação (seção 23 do prompt mestre), todo executável no DEMO:

1. Home → banners empilhados → tocar → Tela de Parceiros (azul/branco alternado, PAY MASTER no topo) → tocar num card → sheet com QR e rótulo **PAGAMENTO DIRETO À CARTEIRA DO PARCEIRO — fora do escrow**.
2. OTC-0001 → Deal Room → Participantes → **GERAR CONVITE** na cadeira vazia → copiar link/código/mensagem.
3. Abrir o link em outro navegador (a prévia não consome) → **ABRIR CONVITE** → código → conectar Verum Wallet (DEMO) → cadastro → termos → Deal Room. Tentar reabrir o link: "Este convite não é mais válido".
4. Resumo → **ENVIAR PARA ASSINATURA** → **ASSINAR PARCERIA** (admin) → o parceiro assina no aparelho dele → **DEMO: assinar como personas pendentes** → **PARTNERSHIP LOCKED**.
5. Estrutura Comercial → tentar alterar um percentual → recusado pelo servidor e pelo banco (só **CRIAR NOVA VERSÃO**).
6. Settlement → **AUTORIZAR LIQUIDAÇÃO** (assinatura separada, explicada antes) → **EXECUTAR DISTRIBUIÇÃO (SIMULADA)** → SETTLED com resíduo visível → Histórico com a trilha completa.

## Arquitetura

```
public/            PWA (mobile-first 360px, desktop com sidebar). Sem CDN: tweetnacl e qrcode-generator embarcados em public/vendor.
  js/app.js        roteador e telas (Home, Parceiros, Deal Room 7 abas, nova oferta, convites, carteira, perfil, dashboard)
  js/invite.js     fluxo do parceiro a partir de /i/:token (TELAS 0–5)
  js/core.js       DOM seguro (sem innerHTML), API, bottom sheet, carteira DEMO, assinaturas
  js/wallet-adapter.js  WalletAdapter do cliente: aceita SOMENTE o provider da Verum Wallet
  js/components.js      Card de Qualificação, Card de Parceiro, sheet de QR, sheet de convite
src/
  app.ts           Fastify: rotas, schemas (additionalProperties:false, sem removeAdditional), headers de segurança, rate limit
  config.ts        .env → configuração; recusa mainnet; exige segredos fora do DEMO
  db.ts            PGlite + migrations (SQL Postgres padrão — roda igual num Postgres de servidor)
  lib/bps.ts       motor de grade/comissões: bps inteiros, BigInt, resíduo explícito, nunca float
  lib/crypto.ts    token 256 bits, código VOTC, HMAC/tempo constante, base58, Ed25519, JSON canônico
  adapters/        SignatureAdapter, AssetAdapter (registry), QrPayloadAdapter (Solana Pay), SettlementAdapter (DEMO), BlockchainAdapter
  services/        auth (challenge/nonce/sessão), invitations (uso único), deals (views com privacidade), partnership (ofertas, linhas, versões, assinaturas, settlement, documentos)
  demo.ts          personas e mesas DEMO (chaves derivadas de sementes PÚBLICAS)
migrations/        001_schema.sql (20 entidades) · 002_guards.sql (triggers de integridade)
docs/              ARQUITETURA, ADR-001, SEGURANCA (checklist), DEVNET
test/              40 testes (node --test)
```

Separação OFF-CHAIN × ON-CHAIN: cadastro, convite, documentos, Deal Room, workflow e auditoria são off-chain. Carteira, assinatura, regras econômicas, escrow, settlement e distribuição ficam atrás de adapters; nesta entrega o único adapter de settlement é o **DEMO_SIMULATED** (nada se move, nenhum selo de proteção é exibido).

## Integridade garantida pelo banco (migration 002)

Mesmo com bug na aplicação, o Postgres recusa: sair de DRAFT com soma de bps ≠ grade; alterar linhas/participantes fora de DRAFT; mudar regras econômicas/política de resíduo/hash dos termos após DRAFT; LOCKED sem todas as assinaturas; convite voltar a ATIVO; convite CONCLUÍDO sem usuário+carteira; função/percentual/credenciais do convite alterados; carteira duplicada na mesma versão; alteração de assinaturas, documentos, settlement finalizado e auditoria.

## API

Onboarding: `GET /i/:token` (não consome) · `POST /invite/open` (consome) · `POST /invite/resume` · `POST /invite/verify-code` · `POST /invite/wallet-challenge` · `POST /invite/wallet-verify` · `POST /invite/signup` · `POST /invite/complete`.
Admin: `POST /invitations` · `GET /invitations?dealId` · `POST /invitations/:id/revoke` · `POST /invitations/:id/regenerate`.
Login sem senha: `POST /auth/wallet-challenge` · `POST /auth/wallet-verify` · `POST /auth/logout`.
Área autenticada (`/api/...`): `me`, `me/deletion-request`, `config`, `assets`, `dashboard`, `deals`, `businesses`, `deals/:id` (view), `/history`, `/compliance`, `/qr/:pid`, `PUT /lines`, `/slots`, `/submit`, `/reopen`, `/new-version`, `/agreement/{challenge,sign}`, `/settlement/{preview,challenge,fund,execute}`, `/documents[...]`, `audit`.

Todo input é validado por JSON Schema com `additionalProperties:false`; autorização é por operação (admin ou participante com convite concluído); respostas de convite inválido são sempre a mesma mensagem.

## Limites honestos

- **Verum Wallet**: não existe API pública de provider web documentada. O cliente aceita somente `id: 'verum-wallet'`; em DEMO há um provider simulado que assina Ed25519 de verdade. O servidor não consegue saber qual software gerou a assinatura; a UI **não** afirma "autocustódia verificada". Deep link "Abrir na Verum Wallet" fica oculto até existir um real.
- **Solana Devnet / contrato**: não implementados nesta entrega (fases 13/14). `SOLANA_NETWORK=solana-devnet` é aceito pela configuração, mas o adapter de blockchain se declara indisponível. Veja `docs/DEVNET.md` e `docs/ADR-001-distribuicao-n-participantes.md`.
- **Mainnet**: recusada. Só depois de testes, revisão de segurança, auditoria independente e autorização explícita.
- **Postgres de servidor**: as migrations são SQL padrão (testadas no Postgres 18 do PGlite), mas um driver `pg` para servidor externo não foi incluído nem testado.

## Comandos

`npm start` · `npm run dev` (watch) · `npm test` · `npm run typecheck` · `npm run db:reset` · `npm run vendor` (re-copia tweetnacl/qrcode para public/vendor) · `npm run preview` (regera a pré-visualização).

## Deploy — este projeto não é compilado

O Node executa os `.ts` direto (type-stripping nativo, daí `engines.node: ">=22.18"`).
Por isso os imports trazem a extensão `.ts` explícita: é o que o Node precisa para resolver
o arquivo. **Não existe passo de build que gere JS**, e não é possível criar um sem reescrever
todos os imports — `allowImportingTsExtensions` exige `noEmit`, e tirar as extensões quebraria
`npm start`.

Configure a plataforma assim:

| | |
|---|---|
| Build command | `npm ci` (ou `npm ci && npm run typecheck`) |
| Start command | `npm start` |
| Node | 22.18+ |

Se a plataforma rodar `tsc` por conta própria, o `tsconfig.json` do repositório já está
configurado para conferir tipos sem emitir. Rodar `tsc` **sem** esse tsconfig é o que produz
os erros `TS5097` (extensão `.ts` no import), `TS2580`/`TS2503` (`process`/`NodeJS` sem
`@types/node`) e `TS2339` (`setTimeout().unref` com a lib do DOM no lugar da do Node).

### `typescript` e `@types/node` estão em `dependencies` de propósito

Não mova para `devDependencies`. Plataformas de deploy costumam instalar só produção
(`NODE_ENV=production` ou `npm ci --omit=dev`) e **ainda assim** rodar `tsc` ao encontrar um
`tsconfig.json` — e aí o build quebra com:

```
error TS2688: Cannot find type definition file for 'node'.
```

Com os dois em `dependencies`, o typecheck funciona em qualquer modo de instalação. O custo é
alguns MB no install de produção; o runtime não usa nenhum dos dois, porque quem apaga os
tipos é o próprio Node. Se você controla o comando de build da plataforma e prefere a
arrumação canônica, mova os dois para `devDependencies` e use
`npm ci --include=dev && npm run typecheck`.

## Pré-visualização navegável

`preview/index.html` é um **arquivo gerado**: um HTML único que roda sem servidor e sem
`node_modules`, com o backend simulado de `preview/mock-backend.js` substituindo o `fetch`.
Editar o `index.html` à mão não serve — a mudança some no próximo build. Mexa nas fontes
(`public/js/*.js`, `public/app.css`, `preview/mock-backend.js`) e regere:

```bash
npm run preview          # escreve preview/index.html
npm run preview:check    # não escreve; sai 1 se o index.html estiver desatualizado
```

Há dois geradores equivalentes: `preview/build.mjs` (Node, usado pelos scripts acima) e
`preview/build.py` (Python). Produzem o mesmo arquivo — ao mexer nas substituições de um,
mexa no outro. O build tem asserções: se uma fonte mudar de forma que quebre uma
substituição, ele falha apontando qual, em vez de gerar uma prévia quebrada em silêncio.
