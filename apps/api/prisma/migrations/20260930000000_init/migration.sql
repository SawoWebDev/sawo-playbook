-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'suspended', 'pending_deletion', 'deleted');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "SopType" AS ENUM ('standard', 'advanced', 'video', 'document');

-- CreateEnum
CREATE TYPE "SopStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'published', 'archived');

-- CreateEnum
CREATE TYPE "VersionLifecycleState" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('approved', 'rejected');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'pdf', 'document');

-- CreateEnum
CREATE TYPE "MediaLifecycleState" AS ENUM ('uploaded', 'attached', 'referenced', 'orphaned', 'soft_deleted', 'purged');

-- CreateEnum
CREATE TYPE "KanbanOrderingType" AS ENUM ('url', 'sop', 'email');

-- CreateEnum
CREATE TYPE "ChecklistStatus" AS ENUM ('in_progress', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "ChecklistResult" AS ENUM ('ok', 'not_ok', 'n/a');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'active',
    "deletion_requested_at" TIMESTAMP(3),
    "deletion_scheduled_for" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "organization_id" UUID NOT NULL,
    "approval_quorum" INTEGER NOT NULL DEFAULT 3,
    "allow_self_approval" BOOLEAN NOT NULL DEFAULT false,
    "public_sop_viewing" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "password_hash" TEXT,
    "sso_provider_id" TEXT,
    "org_role" "OrgRole" NOT NULL,
    "site_scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "folder_scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip" TEXT,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "org_role" "OrgRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "invited_by" UUID NOT NULL,
    "user_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folder" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reference_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SopType" NOT NULL DEFAULT 'standard',
    "folder_id" UUID,
    "qr_public_token" TEXT NOT NULL,
    "current_published_version_id" UUID,
    "latest_draft_version_id" UUID,
    "status" "SopStatus" NOT NULL DEFAULT 'draft',
    "archived_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_version" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sop_id" UUID NOT NULL,
    "version_sequence" INTEGER NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{"cover_sheet":false,"collaborate":false,"checklist_sop":false,"key_points_enabled":false}',
    "lifecycle_state" "VersionLifecycleState" NOT NULL DEFAULT 'DRAFT',
    "current_approval_round" INTEGER NOT NULL DEFAULT 1,
    "change_summary" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "published_by" UUID,
    "published_at" TIMESTAMP(3),
    "pdf_asset_id" UUID,

    CONSTRAINT "sop_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_version_approval" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sop_version_id" UUID NOT NULL,
    "approval_round" INTEGER NOT NULL,
    "approver_id" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sop_version_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_step" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sop_version_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "is_text_only" BOOLEAN NOT NULL DEFAULT false,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "uses_ok_notok_media" BOOLEAN NOT NULL DEFAULT false,
    "linked_sop_id" UUID,
    "linked_sop_version_id" UUID,
    "planned_time_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sop_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "MediaType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_seconds" DOUBLE PRECISION,
    "lifecycle_state" "MediaLifecycleState" NOT NULL DEFAULT 'uploaded',
    "orphaned_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_step_media" (
    "sop_step_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sop_step_media_pkey" PRIMARY KEY ("sop_step_id","media_asset_id")
);

-- CreateTable
CREATE TABLE "kanban" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "part_code" TEXT NOT NULL,
    "part_description" TEXT,
    "picture_asset_id" UUID,
    "supplier" TEXT,
    "supplier_part_no" TEXT,
    "used_for" TEXT,
    "order_when" TEXT,
    "order_qty" TEXT,
    "delivery_time" TEXT,
    "location" TEXT,
    "price" DECIMAL(12,2),
    "carriage" DECIMAL(12,2),
    "custom_field_1" TEXT,
    "custom_field_2" TEXT,
    "ordering_type" "KanbanOrderingType" NOT NULL,
    "ordering_url" TEXT,
    "ordering_sop_id" UUID,
    "ordering_email" TEXT,
    "tag" TEXT,
    "color" TEXT,
    "barcode" TEXT,
    "template" TEXT NOT NULL DEFAULT '01',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "kanban_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_media" (
    "kanban_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,

    CONSTRAINT "kanban_media_pkey" PRIMARY KEY ("kanban_id","media_asset_id")
);

-- CreateTable
CREATE TABLE "trainer_assignment" (
    "organization_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "associate_id" UUID NOT NULL,
    "assigned_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_assignment_pkey" PRIMARY KEY ("trainer_id","associate_id")
);

-- CreateTable
CREATE TABLE "skill_assessment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "associate_id" UUID NOT NULL,
    "sop_id" UUID NOT NULL,
    "sop_version_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "trainer_id" UUID NOT NULL,
    "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "skill_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_record" (
    "organization_id" UUID NOT NULL,
    "associate_id" UUID NOT NULL,
    "sop_id" UUID NOT NULL,
    "current_level" INTEGER NOT NULL,
    "current_sop_version_id" UUID NOT NULL,
    "last_assessment_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_record_pkey" PRIMARY KEY ("associate_id","sop_id")
);

-- CreateTable
CREATE TABLE "checklist_submission" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sop_version_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "status" "ChecklistStatus" NOT NULL DEFAULT 'in_progress',

    CONSTRAINT "checklist_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_response" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "value" TEXT,
    "result" "ChecklistResult",
    "comment" TEXT,
    "media_asset_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_id" UUID,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_organization_id_idx" ON "app_user"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_organization_id_idx" ON "invitation"("organization_id");

-- CreateIndex
CREATE INDEX "folder_organization_id_parent_id_idx" ON "folder"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_qr_public_token_key" ON "sop"("qr_public_token");

-- CreateIndex
CREATE UNIQUE INDEX "sop_current_published_version_id_key" ON "sop"("current_published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_latest_draft_version_id_key" ON "sop"("latest_draft_version_id");

-- CreateIndex
CREATE INDEX "sop_organization_id_status_idx" ON "sop"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sop_organization_id_reference_no_key" ON "sop"("organization_id", "reference_no");

-- CreateIndex
CREATE INDEX "sop_version_organization_id_idx" ON "sop_version"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_version_sop_id_version_sequence_key" ON "sop_version"("sop_id", "version_sequence");

-- CreateIndex
CREATE INDEX "sop_version_approval_organization_id_idx" ON "sop_version_approval"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_version_approval_sop_version_id_approval_round_approver_key" ON "sop_version_approval"("sop_version_id", "approval_round", "approver_id");

-- CreateIndex
CREATE INDEX "sop_step_organization_id_idx" ON "sop_step"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_step_sop_version_id_order_key" ON "sop_step"("sop_version_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_storage_key_key" ON "media_asset"("storage_key");

-- CreateIndex
CREATE INDEX "media_asset_organization_id_lifecycle_state_idx" ON "media_asset"("organization_id", "lifecycle_state");

-- CreateIndex
CREATE INDEX "sop_step_media_media_asset_id_idx" ON "sop_step_media"("media_asset_id");

-- CreateIndex
CREATE INDEX "kanban_organization_id_idx" ON "kanban"("organization_id");

-- CreateIndex
CREATE INDEX "kanban_media_media_asset_id_idx" ON "kanban_media"("media_asset_id");

-- CreateIndex
CREATE INDEX "trainer_assignment_organization_id_idx" ON "trainer_assignment"("organization_id");

-- CreateIndex
CREATE INDEX "skill_assessment_organization_id_associate_id_sop_id_idx" ON "skill_assessment"("organization_id", "associate_id", "sop_id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_record_last_assessment_id_key" ON "skill_record"("last_assessment_id");

-- CreateIndex
CREATE INDEX "skill_record_organization_id_idx" ON "skill_record"("organization_id");

-- CreateIndex
CREATE INDEX "checklist_submission_organization_id_idx" ON "checklist_submission"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_response_submission_id_step_id_key" ON "checklist_response"("submission_id", "step_id");

-- CreateIndex
CREATE INDEX "activity_event_organization_id_event_type_occurred_at_idx" ON "activity_event"("organization_id", "event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_occurred_at_idx" ON "audit_log"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop" ADD CONSTRAINT "sop_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop" ADD CONSTRAINT "sop_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop" ADD CONSTRAINT "sop_current_published_version_id_fkey" FOREIGN KEY ("current_published_version_id") REFERENCES "sop_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop" ADD CONSTRAINT "sop_latest_draft_version_id_fkey" FOREIGN KEY ("latest_draft_version_id") REFERENCES "sop_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_version" ADD CONSTRAINT "sop_version_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_version" ADD CONSTRAINT "sop_version_sop_id_fkey" FOREIGN KEY ("sop_id") REFERENCES "sop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_version" ADD CONSTRAINT "sop_version_pdf_asset_id_fkey" FOREIGN KEY ("pdf_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_version_approval" ADD CONSTRAINT "sop_version_approval_sop_version_id_fkey" FOREIGN KEY ("sop_version_id") REFERENCES "sop_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_step" ADD CONSTRAINT "sop_step_sop_version_id_fkey" FOREIGN KEY ("sop_version_id") REFERENCES "sop_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_step" ADD CONSTRAINT "sop_step_linked_sop_id_fkey" FOREIGN KEY ("linked_sop_id") REFERENCES "sop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_step" ADD CONSTRAINT "sop_step_linked_sop_version_id_fkey" FOREIGN KEY ("linked_sop_version_id") REFERENCES "sop_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_step_media" ADD CONSTRAINT "sop_step_media_sop_step_id_fkey" FOREIGN KEY ("sop_step_id") REFERENCES "sop_step"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sop_step_media" ADD CONSTRAINT "sop_step_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban" ADD CONSTRAINT "kanban_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban" ADD CONSTRAINT "kanban_picture_asset_id_fkey" FOREIGN KEY ("picture_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban" ADD CONSTRAINT "kanban_ordering_sop_id_fkey" FOREIGN KEY ("ordering_sop_id") REFERENCES "sop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_media" ADD CONSTRAINT "kanban_media_kanban_id_fkey" FOREIGN KEY ("kanban_id") REFERENCES "kanban"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_media" ADD CONSTRAINT "kanban_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_assessment" ADD CONSTRAINT "skill_assessment_sop_id_fkey" FOREIGN KEY ("sop_id") REFERENCES "sop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_assessment" ADD CONSTRAINT "skill_assessment_sop_version_id_fkey" FOREIGN KEY ("sop_version_id") REFERENCES "sop_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_record" ADD CONSTRAINT "skill_record_sop_id_fkey" FOREIGN KEY ("sop_id") REFERENCES "sop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_record" ADD CONSTRAINT "skill_record_current_sop_version_id_fkey" FOREIGN KEY ("current_sop_version_id") REFERENCES "sop_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_record" ADD CONSTRAINT "skill_record_last_assessment_id_fkey" FOREIGN KEY ("last_assessment_id") REFERENCES "skill_assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_submission" ADD CONSTRAINT "checklist_submission_sop_version_id_fkey" FOREIGN KEY ("sop_version_id") REFERENCES "sop_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_response" ADD CONSTRAINT "checklist_response_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "checklist_submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_response" ADD CONSTRAINT "checklist_response_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "sop_step"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_response" ADD CONSTRAINT "checklist_response_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Hand-written constraints (not expressible in Prisma schema)
-- ═══════════════════════════════════════════════════════════════════════

-- Invariant #19 (§6.3): at most one active unpublished version per SOP,
-- enforced atomically by the database.
CREATE UNIQUE INDEX "one_active_unpublished_version"
  ON "sop_version" ("sop_id")
  WHERE "lifecycle_state" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED');

-- §6.1a
ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_quorum_positive" CHECK ("approval_quorum" >= 1);

-- §6.3 / §6.4
ALTER TABLE "sop_version"
  ADD CONSTRAINT "sop_version_sequence_positive" CHECK ("version_sequence" >= 1),
  ADD CONSTRAINT "sop_version_round_positive" CHECK ("current_approval_round" >= 1);
ALTER TABLE "sop_version_approval"
  ADD CONSTRAINT "sop_version_approval_round_positive" CHECK ("approval_round" >= 1);

-- §6.5
ALTER TABLE "sop_step"
  ADD CONSTRAINT "sop_step_planned_time_nonneg" CHECK ("planned_time_seconds" >= 0);

-- §6.6
ALTER TABLE "media_asset"
  ADD CONSTRAINT "media_asset_size_nonneg" CHECK ("size_bytes" >= 0);

-- §6.7: exactly one ordering target, matching ordering_type
ALTER TABLE "kanban"
  ADD CONSTRAINT "kanban_ordering_target_matches_type" CHECK (
    ("ordering_type" = 'url'   AND "ordering_url" IS NOT NULL AND "ordering_sop_id" IS NULL AND "ordering_email" IS NULL) OR
    ("ordering_type" = 'sop'   AND "ordering_url" IS NULL AND "ordering_sop_id" IS NOT NULL AND "ordering_email" IS NULL) OR
    ("ordering_type" = 'email' AND "ordering_url" IS NULL AND "ordering_sop_id" IS NULL AND "ordering_email" IS NOT NULL)
  );

-- §6.8: competency levels 0–4
ALTER TABLE "skill_assessment"
  ADD CONSTRAINT "skill_assessment_level_range" CHECK ("level" BETWEEN 0 AND 4);
ALTER TABLE "skill_record"
  ADD CONSTRAINT "skill_record_level_range" CHECK ("current_level" BETWEEN 0 AND 4);

-- Invariant #11 / §6.9: audit_log is immutable. UPDATE is never allowed.
-- DELETE is only allowed inside the documented purge workflow (§7.7/§13),
-- which must run `SET LOCAL gemba.allow_purge = 'on'` in its transaction.
-- activity_event is append-only under the same rule.
CREATE OR REPLACE FUNCTION "gemba_block_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('gemba.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (immutable record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_immutable"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "gemba_block_mutation"();

CREATE TRIGGER "activity_event_append_only"
  BEFORE UPDATE OR DELETE ON "activity_event"
  FOR EACH ROW EXECUTE FUNCTION "gemba_block_mutation"();

-- skill_assessment is a durable history record, never updated in place (§6.8)
CREATE TRIGGER "skill_assessment_no_update"
  BEFORE UPDATE ON "skill_assessment"
  FOR EACH ROW EXECUTE FUNCTION "gemba_block_mutation"();

-- sop_version_approval decisions are immutable historical records (Invariant #17)
CREATE TRIGGER "sop_version_approval_immutable"
  BEFORE UPDATE OR DELETE ON "sop_version_approval"
  FOR EACH ROW EXECUTE FUNCTION "gemba_block_mutation"();
