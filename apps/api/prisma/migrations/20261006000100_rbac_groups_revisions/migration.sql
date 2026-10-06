-- CreateEnum
CREATE TYPE "approval_stage" AS ENUM ('pre', 'final');

-- CreateEnum
CREATE TYPE "kanban_revision_state" AS ENUM ('DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED', 'PUBLISHED', 'DISCARDED');

-- DropIndex
DROP INDEX "sop_version_approval_sop_version_id_approval_round_approver_key";

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "role_permissions" JSONB;

-- AlterTable
ALTER TABLE "invitation" ADD COLUMN     "group_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "sop_version" ADD COLUMN     "routing_group_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "sop_version_approval" ADD COLUMN     "stage" "approval_stage" NOT NULL DEFAULT 'final';

-- CreateTable
CREATE TABLE "user_group" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_member" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_member_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "kanban_revision" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kanban_id" UUID,
    "state" "kanban_revision_state" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "routing_group_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMP(3),
    "pre_approved_by" UUID,
    "pre_approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "published_by" UUID,
    "published_at" TIMESTAMP(3),
    "last_comment" TEXT,
    "last_comment_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_group_organization_id_name_key" ON "user_group"("organization_id", "name");

-- CreateIndex
CREATE INDEX "user_group_member_organization_id_idx" ON "user_group_member"("organization_id");

-- CreateIndex
CREATE INDEX "user_group_member_user_id_idx" ON "user_group_member"("user_id");

-- CreateIndex
CREATE INDEX "kanban_revision_organization_id_state_idx" ON "kanban_revision"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "sop_version_approval_sop_version_id_approval_round_approver_key" ON "sop_version_approval"("sop_version_id", "approval_round", "approver_id", "stage");

-- AddForeignKey
ALTER TABLE "user_group" ADD CONSTRAINT "user_group_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_revision" ADD CONSTRAINT "kanban_revision_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_revision" ADD CONSTRAINT "kanban_revision_kanban_id_fkey" FOREIGN KEY ("kanban_id") REFERENCES "kanban"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Partial index: the single active unpublished version now also covers PENDING_PRE_APPROVAL ──
DROP INDEX "one_active_unpublished_version";
CREATE UNIQUE INDEX "one_active_unpublished_version"
  ON "sop_version" ("sop_id")
  WHERE "lifecycle_state" IN ('DRAFT', 'PENDING_PRE_APPROVAL', 'PENDING_APPROVAL', 'APPROVED');

-- ── At most one open revision per live kanban (the live row itself is never a draft) ──
CREATE UNIQUE INDEX "kanban_revision_one_open_per_kanban"
  ON "kanban_revision" ("kanban_id")
  WHERE "kanban_id" IS NOT NULL AND "state" IN ('DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED');

-- ── Roles: only Admin, Viewer (OPERATOR), Editor, Pre Approver, Approver remain in use ──
-- Owner (the account holder) becomes Admin; Admin already has full access. Trainer rows were moved to Editor earlier.
UPDATE "app_user"   SET "org_role" = 'ADMIN' WHERE "org_role" IN ('OWNER', 'TRAINER');
-- Pending invitations are NOT users yet, so they are never converted into another role. A pending Owner or Trainer
-- invitation is revoked (existing status, history kept, role left as it was). It cannot be accepted afterwards.
UPDATE "invitation" SET "status" = 'revoked' WHERE "org_role" IN ('OWNER', 'TRAINER') AND "status" = 'pending';

-- ── Groups: every existing non-Admin user joins a default "General" group so no one is left ungrouped ──
INSERT INTO "user_group" ("id", "organization_id", "name", "updated_at")
SELECT gen_random_uuid(), o."id", 'General', CURRENT_TIMESTAMP
FROM "organization" o
WHERE EXISTS (SELECT 1 FROM "app_user" u WHERE u."organization_id" = o."id" AND u."org_role" <> 'ADMIN');

INSERT INTO "user_group_member" ("group_id", "user_id", "organization_id")
SELECT g."id", u."id", u."organization_id"
FROM "app_user" u
JOIN "user_group" g ON g."organization_id" = u."organization_id" AND g."name" = 'General'
WHERE u."org_role" <> 'ADMIN';

-- Pending invitations for the non-Admin roles that remain valid join the default group on acceptance.
UPDATE "invitation" i
SET "group_ids" = ARRAY[g."id"]
FROM "user_group" g
WHERE g."organization_id" = i."organization_id" AND g."name" = 'General'
  AND i."status" = 'pending' AND i."org_role" IN ('OPERATOR', 'EDITOR', 'APPROVER');

-- ── Same-tenant integrity: a membership must reference a group and a user of the SAME organisation ──
-- Prisma cannot express composite foreign keys, so these live here. `prisma migrate diff` will report them as drift.
ALTER TABLE "user_group" ADD CONSTRAINT "user_group_id_organization_id_key" UNIQUE ("id", "organization_id");
ALTER TABLE "app_user"   ADD CONSTRAINT "app_user_id_organization_id_key"   UNIQUE ("id", "organization_id");
ALTER TABLE "user_group_member" DROP CONSTRAINT "user_group_member_group_id_fkey";
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_group_same_org_fkey"
  FOREIGN KEY ("group_id", "organization_id") REFERENCES "user_group"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_group_member" DROP CONSTRAINT "user_group_member_user_id_fkey";
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_user_same_org_fkey"
  FOREIGN KEY ("user_id", "organization_id") REFERENCES "app_user"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Backfill routing for SOP approvals already in flight: scope them to the submitter's groups (not organisation-wide) ──
UPDATE "sop_version" v
SET "routing_group_ids" = ARRAY(
  SELECT m."group_id" FROM "user_group_member" m WHERE m."user_id" = v."submitted_by" ORDER BY m."group_id")
WHERE v."lifecycle_state" IN ('PENDING_APPROVAL', 'APPROVED') AND v."submitted_by" IS NOT NULL;
