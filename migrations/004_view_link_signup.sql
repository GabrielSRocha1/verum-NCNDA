-- VERUM NCNDA PRIVATE DAPP — Migration 004: cadastro de visualizador pelo link
-- Abre um segundo caminho de entrada na plataforma, ao lado do convite: quem recebe um link de
-- visualização pode provar a carteira e criar cadastro de VISUALIZADOR. Continua não existindo
-- cadastro público — é preciso um link secreto emitido pelo admin da mesa —, e esse cadastro não
-- dá pertencimento a mesa nenhuma: a pessoa só lê a operação onde se identificou.

-- Novo propósito de desafio. A restrição de 001 é anônima, então o nome é descoberto pela
-- definição em vez de adivinhado: errar o nome faria o DROP não achar nada, a restrição antiga
-- continuaria recusando VIEW_LINK e a migration "passaria" deixando o recurso quebrado.
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
  CHECK (purpose IN ('INVITE','LOGIN','AGREEMENT','DOCUMENT','SETTLEMENT','VIEW_LINK'));

-- VIEW_LINK, como LOGIN, não pertence a convite nenhum.
ALTER TABLE wallet_challenges ADD CONSTRAINT wallet_challenges_view_link_no_invite
  CHECK (purpose <> 'VIEW_LINK' OR invitation_id IS NULL);

-- Como a conta nasceu. Quem entrou por link de visualização lê a operação que lhe mostraram, mas
-- não cria mesa própria nem convida ninguém: o admin compartilhou leitura, não um lugar na
-- plataforma. Concluir um convite depois promove a conta para INVITE e abre o resto.
ALTER TABLE users ADD COLUMN origin text NOT NULL DEFAULT 'INVITE'
  CHECK (origin IN ('INVITE', 'VIEW_LINK'));
