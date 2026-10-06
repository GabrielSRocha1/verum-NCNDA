-- VERUM NCNDA PRIVATE DAPP — Migration 002: guardas de integridade no banco
-- Mesmo que a aplicação tenha um bug, o banco recusa: soma de bps inconsistente ao sair de DRAFT,
-- alteração de linhas/participantes fora de DRAFT, convite voltando a ATIVO, convite CONCLUÍDO sem
-- usuário/carteira, carteira duplicada na mesma versão, auditoria mutável.

-- ---------------------------------------------------------------- versões da parceria
CREATE OR REPLACE FUNCTION pv_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sum     int;
  v_empty   int;
  v_n       int;
  v_signed  int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'VERSION_MUST_START_DRAFT';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'DRAFT' AND (NEW.grade_total_bps <> OLD.grade_total_bps OR NEW.residual_policy <> OLD.residual_policy) THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: regras econômicas só mudam em DRAFT';
  END IF;
  IF NEW.partnership_id <> OLD.partnership_id OR NEW.version_no <> OLD.version_no THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.terms_hash IS DISTINCT FROM OLD.terms_hash AND OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: hash dos termos travado';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD.status, NEW.status) IN (
      ('DRAFT','PENDING_SIGNATURES'), ('DRAFT','CANCELLED'), ('DRAFT','EXPIRED'),
      ('PENDING_SIGNATURES','DRAFT'), ('PENDING_SIGNATURES','LOCKED'),
      ('PENDING_SIGNATURES','EXPIRED'), ('PENDING_SIGNATURES','CANCELLED'),
      ('LOCKED','FUNDED'), ('LOCKED','CANCELLED'),
      ('FUNDED','EXECUTING'), ('EXECUTING','SETTLED'))) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'PENDING_SIGNATURES' THEN
    SELECT COALESCE(SUM(bps),0) INTO v_sum FROM allocation_lines WHERE version_id = NEW.id;
    IF v_sum <> NEW.grade_total_bps THEN
      RAISE EXCEPTION 'BPS_SUM_MISMATCH: soma % bps <> grade % bps', v_sum, NEW.grade_total_bps;
    END IF;
    SELECT COUNT(*) INTO v_empty FROM partnership_participants WHERE version_id = NEW.id AND wallet_id IS NULL;
    IF v_empty > 0 THEN
      RAISE EXCEPTION 'PARTICIPANTS_INCOMPLETE: % cadeira(s) sem carteira', v_empty;
    END IF;
    IF NEW.terms_hash IS NULL THEN
      RAISE EXCEPTION 'TERMS_HASH_REQUIRED';
    END IF;
  END IF;

  IF OLD.status = 'PENDING_SIGNATURES' AND NEW.status = 'DRAFT' THEN
    NEW.terms_hash := NULL;
  END IF;

  IF NEW.status = 'LOCKED' THEN
    SELECT COUNT(*) INTO v_n FROM partnership_participants WHERE version_id = NEW.id;
    SELECT COUNT(*) INTO v_signed FROM signatures s
      JOIN partnership_participants p ON p.id = s.participant_id
     WHERE s.version_id = NEW.id AND s.kind = 'AGREEMENT' AND s.invalidated_at IS NULL
       AND s.terms_hash = NEW.terms_hash AND s.user_id = p.user_id;
    IF v_n = 0 OR v_signed <> v_n THEN
      RAISE EXCEPTION 'SIGNATURES_INCOMPLETE: %/%', v_signed, v_n;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pv_guard_trg BEFORE INSERT OR UPDATE ON partnership_versions
  FOR EACH ROW EXECUTE FUNCTION pv_guard();

-- ---------------------------------------------------------------- linhas e participantes só em DRAFT
CREATE OR REPLACE FUNCTION draft_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_version uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_version := OLD.version_id; ELSE v_version := NEW.version_id; END IF;
  SELECT status INTO v_status FROM partnership_versions WHERE id = v_version;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'LOCKED_VERSION: % só pode ser alterado em DRAFT (status atual: %)', TG_TABLE_NAME, v_status;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER allocation_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON allocation_lines
  FOR EACH ROW EXECUTE FUNCTION draft_only_guard();
CREATE TRIGGER participants_draft_only BEFORE INSERT OR UPDATE OR DELETE ON partnership_participants
  FOR EACH ROW EXECUTE FUNCTION draft_only_guard();

-- ---------------------------------------------------------------- convites
CREATE OR REPLACE FUNCTION invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ATIVO' THEN RAISE EXCEPTION 'INVITE_MUST_START_ATIVO'; END IF;
    SELECT status INTO v_status FROM partnership_versions WHERE id = NEW.partnership_version_id;
    IF v_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVITE_REQUIRES_DRAFT: em parceria travada, convide dentro de uma nova versão';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.deal_id <> OLD.deal_id OR NEW.partnership_version_id <> OLD.partnership_version_id
     OR NEW.participant_id <> OLD.participant_id OR NEW.role_id <> OLD.role_id OR NEW.role_seq <> OLD.role_seq
     OR NEW.bps <> OLD.bps OR NEW.token_hash <> OLD.token_hash OR NEW.code_hash <> OLD.code_hash
     OR NEW.created_by <> OLD.created_by OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'INVITE_IMMUTABLE: função, percentual e credenciais do convite não mudam';
  END IF;

  IF NEW.status = 'ATIVO' AND OLD.status <> 'ATIVO' THEN
    RAISE EXCEPTION 'INVITE_CANNOT_RETURN_TO_ATIVO';
  END IF;

  IF OLD.status IN ('CONCLUIDO','EXPIRADO','REVOGADO','BLOQUEADO') THEN
    -- Estado terminal: só é permitido registrar o convite substituto (gerar novo link).
    IF NEW.status <> OLD.status
       OR NEW.failed_attempts <> OLD.failed_attempts
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
       OR (OLD.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id) THEN
      RAISE EXCEPTION 'INVITE_TERMINAL: %', OLD.status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
      ('ATIVO','ABERTO'), ('ATIVO','REVOGADO'), ('ATIVO','EXPIRADO'),
      ('ABERTO','CONCLUIDO'), ('ABERTO','EXPIRADO'), ('ABERTO','REVOGADO'), ('ABERTO','BLOQUEADO'))) THEN
    RAISE EXCEPTION 'INVITE_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invitation_guard_trg BEFORE INSERT OR UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitation_guard();

-- ---------------------------------------------------------------- assinaturas: só invalidar
CREATE OR REPLACE FUNCTION signature_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SIGNATURE_APPEND_ONLY'; END IF;
  IF OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
     OR NEW.message <> OLD.message OR NEW.signature <> OLD.signature OR NEW.terms_hash <> OLD.terms_hash
     OR NEW.user_id <> OLD.user_id OR NEW.wallet_address <> OLD.wallet_address THEN
    RAISE EXCEPTION 'SIGNATURE_APPEND_ONLY: assinatura só pode ser invalidada';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_guard_trg BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION signature_guard();

-- ---------------------------------------------------------------- settlement
CREATE OR REPLACE FUNCTION settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM partnership_versions WHERE id = NEW.version_id;
    IF v_status NOT IN ('LOCKED','FUNDED') THEN
      RAISE EXCEPTION 'SETTLEMENT_REQUIRES_LOCKED';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SETTLEMENT_APPEND_ONLY'; END IF;
  IF OLD.status = 'SETTLED' THEN RAISE EXCEPTION 'SETTLEMENT_FINAL'; END IF;
  IF NEW.lines <> OLD.lines OR NEW.reference_amount <> OLD.reference_amount OR NEW.pool_amount <> OLD.pool_amount
     OR NEW.residual_units <> OLD.residual_units THEN
    RAISE EXCEPTION 'SETTLEMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlement_guard();

-- ---------------------------------------------------------------- documentos: versões imutáveis
CREATE OR REPLACE FUNCTION immutable_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_ROW: % é somente inserção', TG_TABLE_NAME;
END $$;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_row_guard();

-- ---------------------------------------------------------------- auditoria append-only
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION immutable_row_guard();
