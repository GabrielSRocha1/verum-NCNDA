-- VERUM NCNDA PRIVATE DAPP — Migration 003: link de visualização da mesa
-- Um link por mesa, só leitura, gerado e revogado pelo admin (Pay Master 01). Quem abre precisa
-- entrar com a carteira e se identificar ANTES de ver qualquer coisa da operação (padrão NCNDA):
-- o portão devolve só o cabeçalho da mesa, nada de participantes, percentuais ou documentos.

-- O token fica em CLARO, ao contrário do convite (que guarda apenas hash). A diferença é de
-- finalidade: o convite vale uma vez e nunca precisa ser reexibido, enquanto o link de
-- visualização é permanente até ser revogado e o admin precisa poder reexibir e recompartilhar o
-- MESMO link. É um segredo de URL — quem tem o link tem o acesso —, e por isso regenerar troca o
-- token e invalida o anterior na hora.
ALTER TABLE deals ADD COLUMN view_token text UNIQUE CHECK (view_token ~ '^[A-Za-z0-9_-]{43}$');

-- Quem se identificou para abrir o link. É registro de acesso: só inserção, como a auditoria.
-- Os dados são os que a pessoa declarou; a carteira é a que assinou a sessão. A mesa não verifica
-- nome, e-mail ou telefone — e a interface diz isso a quem lê a lista.
CREATE TABLE deal_viewers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     uuid NOT NULL REFERENCES deals(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  full_name   text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 120),
  email       text NOT NULL CHECK (char_length(email) BETWEEN 5 AND 254),
  phone       text NOT NULL CHECK (char_length(phone) BETWEEN 8 AND 24),
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  wallet      text NOT NULL CHECK (char_length(wallet) BETWEEN 32 AND 64),
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, user_id)
);
CREATE INDEX deal_viewers_deal_idx ON deal_viewers (deal_id, at DESC);

CREATE TRIGGER deal_viewers_immutable BEFORE UPDATE OR DELETE ON deal_viewers
  FOR EACH ROW EXECUTE FUNCTION immutable_row_guard();
