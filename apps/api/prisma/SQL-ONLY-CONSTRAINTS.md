# Constraints that live only in migration SQL

Prisma cannot express the constraints below in `schema.prisma`. They are created by hand-written SQL in
`prisma/migrations/*/migration.sql`. Prisma's diff does not see them, so `prisma migrate dev` will **not** drop
them, but nothing in the schema documents them either. Treat this file as the record.

## Partial unique indexes (WHERE clauses)
- `one_active_unpublished_version` (`sop_version`, `sop_id` WHERE state IN DRAFT, PENDING_PRE_APPROVAL, PENDING_APPROVAL, APPROVED) — Invariant #19: one active unpublished version per SOP.
- `kanban_revision_one_open_per_kanban` (`kanban_revision`, `kanban_id` WHERE kanban_id IS NOT NULL AND state IN DRAFT, PENDING_PRE_APPROVAL, PRE_APPROVED, APPROVED) — one open revision per live card.

## CHECK constraints
- `kanban_ordering_target_matches_type` (`kanban`) — ordering target must match ordering_type.
- `organization_settings_quorum_positive`, `sop_version_sequence_positive`, `sop_version_round_positive`, `sop_version_approval_round_positive`.
- `skill_assessment_level_range`, `skill_record_level_range`, `sop_step_planned_time_nonneg`, `media_asset_size_nonneg`.

## Triggers and functions
- Immutability: `audit_log_immutable`, `activity_event_append_only`, `sop_version_approval_immutable`, `sop_version_published_immutable`, `sop_step_immutable_unless_draft`, `sop_step_media_immutable_unless_draft`, `skill_assessment_no_update`. Function `gemba_block_mutation()`.
- Full-text search maintenance: `sop_search_tsv`, `folder_rename_tsv`, `sop_step_tsv_*`.

## Constraints that *are* in schema.prisma with an explicit name
These were moved into the schema so Prisma sees them, using the exact names from the migration:
- `user_group_member_group_same_org_fkey` and `user_group_member_user_same_org_fkey` (composite FKs `(group_id, organization_id)` and `(user_id, organization_id)`).
- `user_group_id_organization_id_key` and `app_user_id_organization_id_key` (composite unique keys they reference).

## Known pre-existing drift (not from the RBAC work)
`prisma migrate diff` reports `kanban_search_tsv_idx`, `sop_search_tsv_idx`, `sop_version_content_tsv_idx` and a
`kanban.search_tsv` default. They come from `20260930030000_full_text_search` and are `Unsupported("tsvector")` fields.
Resolve in a separate change; do not let it hide other drift.

## Review rule for every new migration
1. Run `prisma migrate diff --from-url <migrated DB> --to-schema-datamodel prisma/schema.prisma --script`.
2. Anything it proposes to DROP must be understood before it is applied. A DROP of anything listed above is a bug.
3. If a constraint in this file is changed, update this file in the same change.
4. Never run `prisma migrate reset` against a database that holds real data.
