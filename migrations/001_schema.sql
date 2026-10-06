-- VERUM NCNDA PRIVATE DAPP — Migration 001: schema principal
-- Valores percentuais: pontos-base inteiros (bps). Valores monetários: numeric(78,0) em unidade mínima.

CREATE TABLE roles (
  key            text PRIMARY KEY,
  label          text NOT NULL,
  chain_order    int  NOT NULL UNIQUE,
  is_pay_master  boolean NOT NULL DEFAULT false
);

INSERT INTO roles (key, label, chain_order, is_pay_master) VALUES
  ('VENDEDOR',             'Vendedor',               1, false),
  ('GRUPO_VENDA',          'Grupo Venda',            2, false),
  ('INTERMEDIACAO_VENDA',  'Intermediação Venda',    3, false),
  ('PAY_MASTER',           'Pay Master / Ligação',   4, true),
  ('INTERMEDIACAO_COMPRA', 'Intermediação Compra',   5, false),
  ('GRUPO_COMPRA',         'Grupo Compra',           6, false),
  ('COMPRADOR',            'Comprador',              7, false);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 120),
  email       text NOT NULL CHECK (char_length(email) BETWEEN 5 AND 254),
  phone       text NOT NULL CHECK (char_length(phone) BETWEEN 8 AND 24),
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  is_demo     boolean NOT NULL DEFAULT false,
  terms_accepted_at timestamptz,
  deletion_requested_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE wallets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network     text NOT NULL,
  address     text NOT NULL CHECK (char_length(address) BETWEEN 32 AND 64),
  provider    text NOT NULL DEFAULT 'verum-wallet',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, address),
  UNIQUE (user_id, network)
);

CREATE TABLE assets (
  id          text PRIMARY KEY,
  symbol      text NOT NULL,
  name        text NOT NULL,
  network     text NOT NULL,
  mint        text,
  decimals    int  NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  status      text NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  verified    boolean NOT NULL DEFAULT false,
  leg_type    text NOT NULL CHECK (leg_type IN ('ONCHAIN','CASH_PHYSICAL','FIAT_TRANSFER','PHYSICAL_ASSET')),
  environment text NOT NULL CHECK (environment IN ('DEMO','DEVNET','MAINNET','OFFCHAIN')),
  UNIQUE (network, mint),
  CHECK ((leg_type = 'ONCHAIN') OR (mint IS NULL))
);

CREATE TABLE businesses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  tagline        text CHECK (tagline IS NULL OR char_length(tagline) <= 140),
  admin_user_id  uuid NOT NULL REFERENCES users(id),
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('UNICA','PERMANENTE')),
  business_id        uuid REFERENCES businesses(id),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
  volume_text        text NOT NULL CHECK (char_length(volume_text) BETWEEN 1 AND 80),
  reference_amount   numeric(78,0) CHECK (reference_amount IS NULL OR reference_amount > 0),
  reference_asset_id text REFERENCES assets(id),
  grade_total_bps    int NOT NULL CHECK (grade_total_bps BETWEEN 1 AND 10000),
  grade_payer_bps    int NOT NULL CHECK (grade_payer_bps >= 0),
  conditions         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(conditions) <= 5),
  valid_until        timestamptz,
  is_demo            boolean NOT NULL DEFAULT false,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (grade_payer_bps <= grade_total_bps),
  CHECK ((kind = 'PERMANENTE') = (business_id IS NOT NULL)),
  CHECK ((reference_amount IS NULL) = (reference_asset_id IS NULL))
);

CREATE TABLE offer_legs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  side        text NOT NULL CHECK (side IN ('ENTREGA','RECEBIMENTO')),
  asset_id    text NOT NULL REFERENCES assets(id),
  leg_type    text NOT NULL CHECK (leg_type IN ('ONCHAIN','CASH_PHYSICAL','FIAT_TRANSFER','PHYSICAL_ASSET')),
  description text CHECK (description IS NULL OR char_length(description) <= 80),
  UNIQUE (offer_id, side)
);

CREATE TABLE deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^OTC-[0-9]{4,}$'),
  offer_id       uuid NOT NULL UNIQUE REFERENCES offers(id),
  admin_user_id  uuid NOT NULL REFERENCES users(id),
  is_demo        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE deal_code_seq START 1;

-- Pertencimento à operação (autorização por operação)
CREATE TABLE deal_participants (
  deal_id        uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  via_invitation uuid,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, user_id)
);

CREATE TABLE partnerships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id            uuid NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
  current_version_id uuid
);

CREATE TABLE partnership_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id   uuid NOT NULL REFERENCES partnerships(id) ON DELETE CASCADE,
  version_no       int  NOT NULL CHECK (version_no >= 1),
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','PENDING_SIGNATURES','LOCKED','FUNDED','EXECUTING','SETTLED','EXPIRED','CANCELLED')),
  residual_policy  text NOT NULL DEFAULT 'TO_PAY_MASTER'
                   CHECK (residual_policy IN ('TO_PAY_MASTER','TO_PAYER','TO_SELL_INTERMEDIARY','TO_BUY_INTERMEDIARY')),
  grade_total_bps  int NOT NULL CHECK (grade_total_bps BETWEEN 1 AND 10000),
  terms_hash       text CHECK (terms_hash IS NULL OR terms_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id    uuid REFERENCES partnership_versions(id),
  superseded_by_id uuid REFERENCES partnership_versions(id),
  locked_at        timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partnership_id, version_no)
);
ALTER TABLE partnerships
  ADD CONSTRAINT partnerships_current_fk FOREIGN KEY (current_version_id) REFERENCES partnership_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE partnership_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES partnership_versions(id) ON DELETE CASCADE,
  role_key         text NOT NULL REFERENCES roles(key),
  seq              int  NOT NULL DEFAULT 1 CHECK (seq BETWEEN 1 AND 9),
  user_id          uuid REFERENCES users(id),
  wallet_id        uuid REFERENCES wallets(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, role_key, seq),
  UNIQUE (version_id, wallet_id),
  UNIQUE (version_id, user_id),
  CHECK ((user_id IS NULL) = (wallet_id IS NULL))
);

CREATE TABLE allocation_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES partnership_versions(id) ON DELETE CASCADE,
  position    int  NOT NULL CHECK (position >= 0),
  line_key    text NOT NULL CHECK (line_key ~ '^[a-z0-9_]{1,40}$'),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  role_key    text REFERENCES roles(key),
  role_seq    int  NOT NULL DEFAULT 1,
  bps         int  NOT NULL CHECK (bps BETWEEN 0 AND 10000),
  kind        text NOT NULL CHECK (kind IN ('PAGADOR','GRUPO_VENDA','GRUPO_COMPRA','INTERMEDIACAO','COMISSAO','RESIDUO')),
  UNIQUE (version_id, line_key)
);

CREATE TABLE invitations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  partnership_version_id uuid NOT NULL REFERENCES partnership_versions(id),
  participant_id         uuid NOT NULL REFERENCES partnership_participants(id),
  role_id                text NOT NULL REFERENCES roles(key),
  role_seq               int  NOT NULL DEFAULT 1,
  bps                    int  NOT NULL CHECK (bps BETWEEN 0 AND 10000),
  token_hash             text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  code_hash              text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  status                 text NOT NULL DEFAULT 'ATIVO'
                         CHECK (status IN ('ATIVO','ABERTO','CONCLUIDO','EXPIRADO','REVOGADO','BLOQUEADO')),
  failed_attempts        int  NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  expires_at             timestamptz NOT NULL,
  opened_at              timestamptz,
  opened_session_hash    text,
  code_verified_at       timestamptz,
  pending_wallet_address text,
  wallet_verified_at     timestamptz,
  completed_at           timestamptz,
  revoked_at             timestamptz,
  replaced_by_id         uuid REFERENCES invitations(id),
  user_id                uuid REFERENCES users(id),
  wallet_id              uuid REFERENCES wallets(id),
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CONCLUIDO' OR (user_id IS NOT NULL AND wallet_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status = 'ATIVO' OR status = 'REVOGADO' OR status = 'EXPIRADO' OR opened_at IS NOT NULL)
);
CREATE INDEX invitations_deal_idx ON invitations (deal_id, created_at DESC);
CREATE INDEX invitations_status_idx ON invitations (status, expires_at);
-- No máximo um convite "vivo" por cadeira
CREATE UNIQUE INDEX invitations_one_live_per_slot ON invitations (participant_id) WHERE status IN ('ATIVO','ABERTO');

CREATE TABLE wallet_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose         text NOT NULL CHECK (purpose IN ('INVITE','LOGIN','AGREEMENT','DOCUMENT','SETTLEMENT')),
  invitation_id   uuid REFERENCES invitations(id),
  wallet_address  text NOT NULL,
  nonce_hash      text NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (purpose <> 'INVITE' OR invitation_id IS NOT NULL),
  CHECK (purpose <> 'LOGIN' OR invitation_id IS NULL)
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no          int  NOT NULL CHECK (version_no >= 1),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime                text NOT NULL,
  size_bytes          int  NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  content             bytea NOT NULL,
  requires_acceptance boolean NOT NULL DEFAULT true,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

CREATE TABLE signatures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('AGREEMENT','DOCUMENT','SETTLEMENT_AUTH')),
  version_id          uuid REFERENCES partnership_versions(id),
  participant_id      uuid REFERENCES partnership_participants(id),
  document_version_id uuid REFERENCES document_versions(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  wallet_address      text NOT NULL,
  terms_hash          text NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  message             text NOT NULL,
  signature           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  invalidated_at      timestamptz,
  CHECK (kind <> 'AGREEMENT' OR (version_id IS NOT NULL AND participant_id IS NOT NULL)),
  CHECK (kind <> 'DOCUMENT' OR document_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX signatures_one_valid_agreement ON signatures (participant_id) WHERE kind = 'AGREEMENT' AND invalidated_at IS NULL;
CREATE UNIQUE INDEX signatures_one_doc_accept ON signatures (document_version_id, user_id) WHERE kind = 'DOCUMENT';

CREATE TABLE settlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id           uuid NOT NULL UNIQUE REFERENCES partnership_versions(id),
  adapter              text NOT NULL,
  status               text NOT NULL CHECK (status IN ('FUNDED','EXECUTING','SETTLED')),
  asset_id             text NOT NULL REFERENCES assets(id),
  reference_amount     numeric(78,0) NOT NULL,
  pool_amount          numeric(78,0) NOT NULL,
  residual_units       numeric(78,0) NOT NULL,
  truncated_numerator  int NOT NULL CHECK (truncated_numerator BETWEEN 0 AND 9999),
  lines                jsonb NOT NULL,
  authorization_sig_id uuid REFERENCES signatures(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  settled_at           timestamptz
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  user_id     uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  deal_id     uuid,
  old_value   jsonb,
  new_value   jsonb,
  wallet      text,
  meta        jsonb
);
CREATE INDEX audit_logs_deal_idx ON audit_logs (deal_id, id);
