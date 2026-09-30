-- §14 PostgreSQL full-text search. tsvectors are updated synchronously on write.
-- The 'simple' configuration is used so part codes / reference numbers are not stemmed.

ALTER TABLE "sop" ADD COLUMN "search_tsv" tsvector;
ALTER TABLE "sop_version" ADD COLUMN "content_tsv" tsvector;
ALTER TABLE "kanban" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (
  to_tsvector('simple',
    coalesce("part_code", '') || ' ' || coalesce("part_description", '') || ' ' ||
    coalesce("supplier", '') || ' ' || coalesce("supplier_part_no", '') || ' ' ||
    coalesce("used_for", '') || ' ' || coalesce("tag", ''))
) STORED;

CREATE INDEX "sop_search_tsv_idx" ON "sop" USING GIN ("search_tsv");
CREATE INDEX "sop_version_content_tsv_idx" ON "sop_version" USING GIN ("content_tsv");
CREATE INDEX "kanban_search_tsv_idx" ON "kanban" USING GIN ("search_tsv");

-- SOP identity: name, reference number (weight A) and folder name (weight C)
CREATE OR REPLACE FUNCTION "gemba_sop_tsv"() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.reference_no, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce((SELECT name FROM folder WHERE id = NEW.folder_id), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sop_search_tsv"
  BEFORE INSERT OR UPDATE OF "name", "reference_no", "folder_id" ON "sop"
  FOR EACH ROW EXECUTE FUNCTION "gemba_sop_tsv"();

-- Folder rename → refresh the SOPs filed in it
CREATE OR REPLACE FUNCTION "gemba_folder_rename_tsv"() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE sop SET folder_id = folder_id WHERE folder_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "folder_rename_tsv"
  AFTER UPDATE OF "name" ON "folder"
  FOR EACH ROW EXECUTE FUNCTION "gemba_folder_rename_tsv"();

-- Version content: step titles (B) + descriptions with HTML stripped (D)
CREATE OR REPLACE FUNCTION "gemba_refresh_version_tsv"(p_version uuid) RETURNS void AS $$
  UPDATE sop_version v SET content_tsv = (
    SELECT
      setweight(to_tsvector('simple', coalesce(string_agg(coalesce(s.title, ''), ' '), '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(string_agg(regexp_replace(s.description, '<[^>]+>', ' ', 'g'), ' '), '')), 'D')
    FROM sop_step s WHERE s.sop_version_id = p_version
  )
  WHERE v.id = p_version;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION "gemba_step_tsv_new"() RETURNS trigger AS $$
BEGIN
  PERFORM gemba_refresh_version_tsv(x.sop_version_id) FROM (SELECT DISTINCT sop_version_id FROM new_rows) x;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "gemba_step_tsv_old"() RETURNS trigger AS $$
BEGIN
  PERFORM gemba_refresh_version_tsv(x.sop_version_id) FROM (SELECT DISTINCT sop_version_id FROM old_rows) x;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Statement-level triggers with transition tables: one refresh per version per statement.
CREATE TRIGGER "sop_step_tsv_ins" AFTER INSERT ON "sop_step"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "gemba_step_tsv_new"();
CREATE TRIGGER "sop_step_tsv_upd" AFTER UPDATE ON "sop_step"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "gemba_step_tsv_new"();
CREATE TRIGGER "sop_step_tsv_del" AFTER DELETE ON "sop_step"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "gemba_step_tsv_old"();

-- Backfill
UPDATE sop SET name = name;
SELECT gemba_refresh_version_tsv(id) FROM sop_version;
