-- VERUM NCNDA PRIVATE DAPP — Migration 005: solicitação de acesso
-- Como nasce o PRIMEIRO Pay Master, já que não há cadastro público e todo convite depende de uma
-- mesa que já tem admin. A pessoa solicita, prova a carteira assinando, e quem opera o servidor
-- aprova por comando (`npm run access`). Aprovar é o único caminho que cria conta sem convite.
--
-- A solicitação NÃO é cadastro: enquanto está PENDENTE não existe usuário, não existe carteira
-- registrada e não há como entrar. Só a aprovação cria as duas linhas, numa transação.

CREATE TABLE access_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Mesmos limites de users (001_schema.sql): o que entra aqui precisa caber lá na aprovação.
  full_name     text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 120),
  email         text NOT NULL CHECK (char_length(email) BETWEEN 5 AND 254),
  phone         text NOT NULL CHECK (char_length(phone) BETWEEN 8 AND 24),
  country       text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  -- Contexto para a decisão. Menos que um KYC, o suficiente para saber quem é e quem indicou.
  organization  text NOT NULL CHECK (char_length(organization) BETWEEN 2 AND 120),
  referral      text CHECK (referral IS NULL OR char_length(referral) BETWEEN 2 AND 120),
  note          text CHECK (note IS NULL OR char_length(note) <= 500),
  -- Carteira comprovada por assinatura no momento da solicitação (desafio VIEW_LINK/ACCESS_REQUEST).
  wallet        text NOT NULL CHECK (char_length(wallet) BETWEEN 32 AND 64),
  status        text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO')),
  user_id       uuid REFERENCES users(id),              -- preenchido na aprovação
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    text,                                   -- quem operou o comando
  decision_note text,
  -- Aprovado sem usuário seria mentira; recusado com usuário também.
  CHECK ((status = 'APROVADO') = (user_id IS NOT NULL))
);

-- Uma solicitação viva por carteira e por e-mail: evita fila de duplicatas e repetição de spam.
-- Parciais de propósito — depois de decidida, a pessoa pode solicitar de novo.
CREATE UNIQUE INDEX access_requests_live_wallet ON access_requests (wallet) WHERE status = 'PENDENTE';
CREATE UNIQUE INDEX access_requests_live_email ON access_requests (lower(email)) WHERE status = 'PENDENTE';
CREATE INDEX access_requests_status_idx ON access_requests (status, created_at DESC);

-- Novo propósito de desafio. A restrição de 001 foi reescrita em 004 com nome conhecido, mas o
-- nome é descoberto pela definição assim mesmo: adivinhar faria o DROP não achar nada, a restrição
-- antiga continuaria recusando ACCESS_REQUEST e a migration "passaria" deixando o recurso quebrado.
-- O filtro casa pela lista de valores ('SETTLEMENT' só aparece nela), e NÃO por 'VIEW_LINK' — esse
-- texto também está na guarda wallet_challenges_view_link_no_invite, que precisa continuar de pé.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'wallet_challenges'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%purpose%'
              AND pg_get_constraintdef(oid) LIKE '%SETTLEMENT%'
  LOOP
    EXECUTE format('ALTER TABLE wallet_challenges DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE wallet_challenges ADD CONSTRAINT wallet_challenges_purpose_check
  CHECK (purpose IN ('INVITE','LOGIN','AGREEMENT','DOCUMENT','SETTLEMENT','VIEW_LINK','ACCESS_REQUEST'));

-- ACCESS_REQUEST, como LOGIN e VIEW_LINK, não pertence a convite nenhum.
ALTER TABLE wallet_challenges ADD CONSTRAINT wallet_challenges_access_request_no_invite
  CHECK (purpose <> 'ACCESS_REQUEST' OR invitation_id IS NULL);
