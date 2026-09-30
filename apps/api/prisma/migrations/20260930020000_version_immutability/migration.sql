-- §10 layer 3 / Invariant #3: database-level protection of SOP version content.
-- Step content is only writable while the parent version is DRAFT (a version
-- under review must not change underneath its approvers, and PUBLISHED is
-- immutable forever). The documented purge workflow may bypass this by
-- running `SET LOCAL gemba.allow_purge = 'on'`.

CREATE OR REPLACE FUNCTION "gemba_purge_allowed"() RETURNS boolean AS $$
  SELECT coalesce(current_setting('gemba.allow_purge', true), '') = 'on';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "gemba_assert_version_draft"(p_version_id uuid) RETURNS void AS $$
DECLARE
  v_state "VersionLifecycleState";
BEGIN
  IF p_version_id IS NULL OR gemba_purge_allowed() THEN
    RETURN;
  END IF;
  SELECT lifecycle_state INTO v_state FROM sop_version WHERE id = p_version_id;
  IF v_state IS NOT NULL AND v_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'SOP version % is % and its content is immutable', p_version_id, v_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- sop_step
CREATE OR REPLACE FUNCTION "gemba_sop_step_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM gemba_assert_version_draft(OLD.sop_version_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM gemba_assert_version_draft(NEW.sop_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sop_step_immutable_unless_draft"
  BEFORE INSERT OR UPDATE OR DELETE ON "sop_step"
  FOR EACH ROW EXECUTE FUNCTION "gemba_sop_step_guard"();

-- sop_step_media
CREATE OR REPLACE FUNCTION "gemba_sop_step_media_guard"() RETURNS trigger AS $$
DECLARE
  v_version uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT sop_version_id INTO v_version FROM sop_step WHERE id = OLD.sop_step_id;
    PERFORM gemba_assert_version_draft(v_version);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT sop_version_id INTO v_version FROM sop_step WHERE id = NEW.sop_step_id;
    PERFORM gemba_assert_version_draft(v_version);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sop_step_media_immutable_unless_draft"
  BEFORE INSERT OR UPDATE OR DELETE ON "sop_step_media"
  FOR EACH ROW EXECUTE FUNCTION "gemba_sop_step_media_guard"();

-- sop_version: once PUBLISHED, nothing changes except the one-time canonical
-- PDF pointer (NULL -> asset); PUBLISHED rows are never deleted.
CREATE OR REPLACE FUNCTION "gemba_sop_version_guard"() RETURNS trigger AS $$
BEGIN
  IF gemba_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.lifecycle_state = 'PUBLISHED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Published SOP version % cannot be deleted', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.organization_id, NEW.sop_id, NEW.version_sequence, NEW.config, NEW.lifecycle_state,
        NEW.current_approval_round, NEW.change_summary, NEW.created_by, NEW.created_at,
        NEW.submitted_by, NEW.submitted_at, NEW.approved_at, NEW.published_by, NEW.published_at)
       IS DISTINCT FROM
       (OLD.organization_id, OLD.sop_id, OLD.version_sequence, OLD.config, OLD.lifecycle_state,
        OLD.current_approval_round, OLD.change_summary, OLD.created_by, OLD.created_at,
        OLD.submitted_by, OLD.submitted_at, OLD.approved_at, OLD.published_by, OLD.published_at)
    THEN
      RAISE EXCEPTION 'Published SOP version % is immutable', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.pdf_asset_id IS DISTINCT FROM OLD.pdf_asset_id AND OLD.pdf_asset_id IS NOT NULL THEN
      RAISE EXCEPTION 'Canonical PDF of published SOP version % cannot be replaced', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sop_version_published_immutable"
  BEFORE UPDATE OR DELETE ON "sop_version"
  FOR EACH ROW EXECUTE FUNCTION "gemba_sop_version_guard"();
