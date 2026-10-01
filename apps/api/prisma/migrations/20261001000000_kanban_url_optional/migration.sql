-- The kanban ordering URL is optional: an "url" card may have no link yet. SOP / email targets stay required.
ALTER TABLE "kanban" DROP CONSTRAINT "kanban_ordering_target_matches_type";
ALTER TABLE "kanban"
  ADD CONSTRAINT "kanban_ordering_target_matches_type" CHECK (
    ("ordering_type" = 'url'   AND "ordering_sop_id" IS NULL AND "ordering_email" IS NULL) OR
    ("ordering_type" = 'sop'   AND "ordering_url" IS NULL AND "ordering_sop_id" IS NOT NULL AND "ordering_email" IS NULL) OR
    ("ordering_type" = 'email' AND "ordering_url" IS NULL AND "ordering_sop_id" IS NULL AND "ordering_email" IS NOT NULL)
  );
