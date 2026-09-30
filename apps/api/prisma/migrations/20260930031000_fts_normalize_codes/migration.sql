-- The 'simple' parser reads codes like "SOP-0002" as word + signed integer ("-0002"),
-- so prefix queries on the numeric part miss. Index a punctuation-normalised copy
-- alongside the raw text for identifier-like fields.

CREATE OR REPLACE FUNCTION "gemba_code_text"(p text) RETURNS text AS $$
  SELECT coalesce(p, '') || ' ' || regexp_replace(coalesce(p, ''), '[^[:alnum:]]+', ' ', 'g');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "gemba_sop_tsv"() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', gemba_code_text(NEW.name)), 'A') ||
    setweight(to_tsvector('simple', gemba_code_text(NEW.reference_no)), 'A') ||
    setweight(to_tsvector('simple', coalesce((SELECT name FROM folder WHERE id = NEW.folder_id), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "kanban_search_tsv_idx";
ALTER TABLE "kanban" DROP COLUMN "search_tsv";
ALTER TABLE "kanban" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (
  to_tsvector('simple',
    gemba_code_text("part_code") || ' ' || coalesce("part_description", '') || ' ' ||
    coalesce("supplier", '') || ' ' || gemba_code_text("supplier_part_no") || ' ' ||
    coalesce("used_for", '') || ' ' || coalesce("tag", ''))
) STORED;
CREATE INDEX "kanban_search_tsv_idx" ON "kanban" USING GIN ("search_tsv");

UPDATE sop SET name = name;
