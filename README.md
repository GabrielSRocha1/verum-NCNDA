# VERUM NCNDA PRIVATE DAPP

Deal Room privada + Partnership Management + DApp para organizar operações OTC entre grupos fechados, com regras de comissão travadas antes da execução.

**Estado desta entrega: DEMO / TESTNET — NO REAL FUNDS.** Não é exchange, corretora nem marketplace. Sem custódia. Sem cadastro público: só se entra por convite privado ou por link de visualização, ambos emitidos pelo admin de uma mesa. Mainnet desligada e recusada na inicialização.

## Rodar em 2 minutos

Requisitos: Node.js 22.18+ (executa TypeScript nativamente; não há etapa de build). O banco é um PostgreSQL 18 embarcado (PGlite), criado automaticamente em `./data/pgdata`.

```bash
npm install
cp .env.example .env        # ajuste COOKIE_SECURE=false para http://localhost
npm start                   # http://localhost:8787
npm test                    # 61 testes (motor de comissões, onboarding 3.9, parceria/banco/settlement)
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
  js/verum-provider.js  ponte para a extensão real: detecta, normaliza o que reconhece e não inventa API
  js/components.js      Card de Qualificação, Card de Parceiro, sheet de QR, sheet de convite
src/
  app.ts           Fastify: rotas, schemas (additionalProperties:false, sem removeAdditional), headers de segurança, rate limit
  config.ts        .env → configuração; recusa mainnet; exige segredos fora do DEMO
  db.ts            dois bancos atrás da mesma interface: Postgres de servidor (DATABASE_URL, via node-postgres) ou PGlite embarcado; migrations em SQL padrão
  lib/bps.ts       motor de grade/comissões: bps inteiros, BigInt, resíduo explícito, nunca float
  lib/crypto.ts    token 256 bits, código VOTC, HMAC/tempo constante, base58, Ed25519, JSON canônico
  adapters/        SignatureAdapter, AssetAdapter (registry), QrPayloadAdapter (Solana Pay), SettlementAdapter (DEMO), BlockchainAdapter
  services/        auth (challenge/nonce/sessão), invitations (uso único), sharing (link de visualização só-leitura), access (solicitação de acesso), deals (views com privacidade), partnership (ofertas, linhas, versões, assinaturas, settlement, documentos)
  demo.ts          personas e mesas DEMO (chaves derivadas de sementes PÚBLICAS)
migrations/        001_schema.sql (20 entidades) · 002_guards.sql (triggers de integridade) · 003_view_link.sql (link de visualização) · 004_view_link_signup.sql (cadastro de visualizador) · 005_access_requests.sql (solicitação de acesso)
docs/              ARQUITETURA, ADR-001, SEGURANCA (checklist), DEVNET
test/              61 testes (node --test)
```

Separação OFF-CHAIN × ON-CHAIN: cadastro, convite, documentos, Deal Room, workflow e auditoria são off-chain. Carteira, assinatura, regras econômicas, escrow, settlement e distribuição ficam atrás de adapters; nesta entrega o único adapter de settlement é o **DEMO_SIMULATED** (nada se move, nenhum selo de proteção é exibido).

## Integridade garantida pelo banco (migration 002)

Mesmo com bug na aplicação, o Postgres recusa: sair de DRAFT com soma de bps ≠ grade; alterar linhas/participantes fora de DRAFT; mudar regras econômicas/política de resíduo/hash dos termos após DRAFT; LOCKED sem todas as assinaturas; convite voltar a ATIVO; convite CONCLUÍDO sem usuário+carteira; função/percentual/credenciais do convite alterados; carteira duplicada na mesma versão; alteração de assinaturas, documentos, settlement finalizado e auditoria.

## API

Onboarding: `GET /i/:token` (não consome) · `POST /invite/open` (consome) · `POST /invite/resume` · `POST /invite/verify-code` · `POST /invite/wallet-challenge` · `POST /invite/wallet-verify` · `POST /invite/signup` · `POST /invite/complete`.
Admin: `POST /invitations` · `GET /invitations?dealId` · `POST /invitations/:id/revoke` · `POST /invitations/:id/regenerate`.
Login sem senha: `POST /auth/wallet-challenge` · `POST /auth/wallet-verify` · `POST /auth/logout`.
Área autenticada (`/api/...`): `me`, `me/deletion-request`, `config`, `assets`, `dashboard`, `deals`, `businesses`, `deals/:id` (view), `/history`, `/compliance`, `/qr/:pid`, `PUT /lines`, `/slots`, `/submit`, `/reopen`, `/new-version`, `/agreement/{challenge,sign}`, `/settlement/{preview,challenge,fund,execute}`, `/documents[...]`, `audit`.
Link de visualização da mesa — admin: `GET/POST /api/deals/:id/share-link` · `POST /api/deals/:id/share-link/regenerate` · `GET /api/deals/:id/viewers`.
Link de visualização — quem abre: `POST /api/shared/:token/wallet-challenge` · `POST /api/shared/:token/wallet-verify` · `GET /api/shared/:token/gate` · `POST /api/shared/:token/register` · e as leituras `GET /api/shared/:token[/history|/compliance|/documents|/documents/:vid/content|/settlement/preview]`.

Solicitação de acesso (só com `ACCESS_REQUESTS=on`): `POST /access/request/wallet-challenge` · `POST /access/request`.

Todo input é validado por JSON Schema com `additionalProperties:false`; autorização é por operação (admin ou participante com convite concluído); respostas de convite inválido são sempre a mesma mensagem.

## Como entra o PRIMEIRO Pay Master

Não há cadastro público, e todo convite depende de uma mesa que já tem admin — então o primeiro não tem de quem receber convite. O caminho é solicitação + aprovação fora da web:

1. Ligue `ACCESS_REQUESTS=on`. Um botão discreto ("Solicitar cadastro") aparece na tela de login.
2. A pessoa preenche nome, e-mail, telefone, país, organização, quem indicou e uma observação, e **assina com a carteira** — é isso que comprova que o endereço é dela. Enviar **não cria conta**: enquanto está pendente, aquela carteira continua sem acesso.
3. Você decide no servidor:

```bash
npm run access -- list
npm run access -- approve <id|e-mail|carteira> --por="seu nome"
npm run access -- reject  <id> --motivo="..."
npm run access -- purge   --dias=90     # descarta recusadas antigas (LGPD)
```

Aprovar cria usuário + carteira numa transação. **É o único caminho do sistema que cria conta sem convite**, e por isso só existe por comando, nunca por rota HTTP. A conta nasce com `origin='INVITE'`: abre mesa própria e convida — diferente do cadastro por link de visualização, que nasce `VIEW_LINK` e só lê.

A partir daí o primeiro Pay Master entra sozinho pela Verum Wallet, cria a mesa e gera os convites para os indicados, pelo fluxo que já existia.

Com banco local (PGlite) **pare o servidor antes de gravar pelo comando** — é de processo único, e o próprio comando avisa. Com `DATABASE_URL` (Postgres de servidor) não há esse limite.

## Limites honestos

- **Verum Wallet**: o cliente aceita somente `id: 'verum-wallet'`. `public/js/verum-provider.js` é a ponte para a extensão real: procura o objeto injetado (`window.verum` e variantes), reconhece as formas que sabe tratar e normaliza para o contrato interno — mas **não inventa API**. Forma desconhecida não vira provider adivinhado: entra no Diagnóstico (Perfil → Carteira), que mostra o que foi encontrado, o que foi recusado e por quê. Em DEMO o provider simulado continua existindo e **convive** com a extensão: o seletor mostra as duas. O servidor não consegue saber qual software gerou a assinatura; a UI **não** afirma "autocustódia verificada". Deep link segue oculto (extensão não tem; app de celular não está implementado).
- **Solana Devnet / contrato**: não implementados nesta entrega (fases 13/14). `SOLANA_NETWORK=solana-devnet` é aceito pela configuração, mas o adapter de blockchain se declara indisponível. Veja `docs/DEVNET.md` e `docs/ADR-001-distribuicao-n-participantes.md`.
- **Mainnet**: recusada. Só depois de testes, revisão de segurança, auditoria independente e autorização explícita.
- **Postgres de servidor**: incluído (`node-postgres`, ligado por `DATABASE_URL`) e exercitado pelo protocolo real do Postgres — migrations, transações com rollback, seed DEMO e o fluxo inteiro do convite. O que **não** foi exercitado é um provedor específico: TLS com CA do provedor, comportamento do pooler sob carga e limites de conexão só se confirmam no ambiente de verdade.
- **Rate limit em serverless**: na Vercel ele conta por instância, não global (ver `api/index.ts`). O bloqueio do convite em 5 erros de código é que vive no banco e vale globalmente.
- **Link de visualização**: é segredo de URL — quem recebe o link pode repassá-lo, e a mesa não tem como saber. O link **é** a autorização: com ele, uma carteira sem cadastro prova posse e cria conta de visualizador. O que limita o estrago: o token é emitido só pelo admin e regenerar invalida o anterior na hora; a pessoa se identifica antes de ver qualquer coisa (o portão mostra só código, título e direção); só existem rotas GET sob `/api/shared/:token`, então visualizador não assina, não convida e não altera; contatos dos participantes não aparecem para quem entra por link; e a conta nasce com `origin = 'VIEW_LINK'`, que lê a operação compartilhada mas **não abre mesa própria** — concluir um convite depois promove a conta e libera o resto.

## Comandos

`npm start` · `npm run dev` (watch) · `npm test` · `npm run typecheck` · `npm run db:reset` · `npm run db:setup` (prepara um banco compartilhado: migrations + seed DEMO) · `npm run access` (solicitações de acesso: list/approve/reject/purge) · `npm run vendor` (re-copia tweetnacl/qrcode para public/vendor) · `npm run preview` (regera a pré-visualização).

## Deploy — este projeto não é compilado

O Node executa os `.ts` direto (type-stripping nativo, daí `engines.node: ">=22.18"`).
Por isso os imports trazem a extensão `.ts` explícita: é o que o Node precisa para resolver
o arquivo. **Não existe passo de build que gere JS**, e não é possível criar um sem reescrever
todos os imports — `allowImportingTsExtensions` exige `noEmit`, e tirar as extensões quebraria
`npm start`.

### A regra que decide tudo: o banco tem que ser compartilhado

Um convite é um registro no banco (token e código guardados só como hash). Quem abre o link
precisa cair no **mesmo banco** em que ele foi criado. Daí as duas formas de publicar:

| Banco | O que acontece com o link enviado |
|---|---|
| PGlite local (`DATA_DIR`) | só abre em quem tem aquele arquivo. Em disco efêmero, o banco some no próximo deploy |
| `DATABASE_URL` (Postgres de servidor) | abre em qualquer navegador e aparelho — é o que faz o convite funcionar de fato |

Sem `DATABASE_URL` o app usa PGlite e nada muda em relação ao desenvolvimento local. Com ela,
`src/db.ts` fala com o Postgres pelo `node-postgres`, atrás da mesma interface, e o `int8` é
lido como `BigInt` nos dois caminhos de propósito — assim a suíte, que roda em PGlite, continua
valendo como prova do que vai para produção.

Prepare o banco **uma vez** por ambiente, da sua máquina:

```bash
DATABASE_URL="postgresql://..." SESSION_SECRET=... INVITE_PEPPER=... npm run db:setup
```

Isso aplica as migrations e semeia as mesas DEMO. O processo que serve o app **não** semeia num
banco compartilhado: duas instâncias subindo juntas criariam as mesas em duplicata.

### Variáveis obrigatórias em qualquer deploy

| Variável | Por quê |
|---|---|
| `DATABASE_URL` | sem ela o estado não atravessa navegadores (ver acima) |
| `PUBLIC_ORIGIN=https://seu-dominio` | entra no link do convite e no domínio que a carteira exibe ao assinar; errada, o convite aponta para outro lugar |
| `SESSION_SECRET`, `INVITE_PEPPER` | 32+ caracteres, **fixos**. Com `DATABASE_URL` o app se recusa a subir sem eles: sorteados a cada boot, o pepper novo invalidaria o código dos convites já enviados e o segredo novo derrubaria as sessões em cada reinício |
| `COOKIE_SECURE=true` | cookies de sessão só por HTTPS |
| `TRUST_PROXY=1` | atrás de proxy/CDN, para o rate limit por IP ver o cliente e não o proxy |

Gere os segredos uma vez e guarde:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Opção A — Vercel (serverless), com Postgres gerenciado

É o que o `vercel.json` do repositório configura: `api/index.ts` envolve o mesmo app Fastify de
`src/`, e todas as rotas são reescritas para essa função. A CDN serve apenas `vercel-static/`,
então nenhum fonte do repositório fica público.

Variáveis na Vercel: as da tabela acima, com `PUBLIC_ORIGIN` igual ao domínio de produção.
`HOST` e `PORT` não se aplicam (não há `listen`).

Com **Supabase**, use a URL do *pooler* (Connection pooling, porta 6543), não a conexão direta:
a direta é IPv6 e as funções da Vercel saem por IPv4. Saiba também que no plano gratuito o
projeto **pausa** depois de alguns dias sem uso, e banco pausado = convite recusado.

Duas diferenças de comportamento, não só de desempenho, documentadas em `api/index.ts`:

- **Rate limit por IP** (`src/lib/common.ts`) vive na memória da instância, então conta por
  instância e fica mais frouxo. A defesa dura contra chute do código do convite não é essa: é o
  contador no banco, que BLOQUEIA o convite em 5 erros.
- **O varredor periódico** de convites expirados (`setInterval` em `src/app.ts`) não roda num
  processo que só vive durante a requisição. A expiração continua acontecendo porque toda rota de
  convite varre antes de responder — só não acontece com ninguém olhando.

Se esses dois pontos incomodarem, a opção B não tem nenhum dos dois.

#### A armadilha do `require(esm)` — não remova o `overrides` do package.json

A Vercel não executa as funções com o carregador de módulos do Node: usa um próprio
(`/opt/rust/nodejs.js`), que **não implementa `require()` de módulo ESM** — recurso que o Node
tem desde a 22.12. Qualquer dependência CommonJS que faça `require()` de um pacote só-ESM
derruba a função com `ERR_REQUIRE_ESM`, mesmo rodando perfeitamente na sua máquina.

Foi o que aconteceu: `@fastify/static` é CommonJS e faz `require('content-disposition')`, que na
versão 3 passou a ser só-ESM. Daí o `overrides` fixando a `^2.0.1`, última com a mesma API
(`create`/`parse`) ainda empacotada como CommonJS.

Para checar isto **antes** de um deploy, reproduza a restrição localmente:

```bash
node --no-experimental-require-module -e "import('./src/app.ts').then(() => console.log('ok'))"
```

Se imprimir `ok`, nenhuma dependência CommonJS está exigindo um pacote só-ESM. Vale rodar depois
de qualquer `npm update` — o erro não aparece em `npm test`, só no deploy.

### Opção B — processo longo (Render, Railway, Fly, VPS)

É o desenho original e o caminho que a suíte cobre inteiro.

| | |
|---|---|
| Build command | `npm ci` (ou `npm ci && npm run typecheck`) |
| Start command | `npm start` |
| Node | 22.18+ |

Aqui `HOST=0.0.0.0` é obrigatório — o padrão `127.0.0.1` só aceita conexão da própria máquina, e
o serviço sobe inacessível. `PORT` costuma ser injetado pela plataforma e o código já o lê.
Funciona com `DATABASE_URL` ou, se preferir PGlite, com um disco persistente montado em `./data`
(sem disco, o DEMO re-semeia a cada boot e os convites antigos morrem).

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
