-- Per-person permissions granted on top of the role (e.g. edit rights for a Pre Approver). Additive and
-- non-destructive: existing rows get an empty list, so nobody's access changes.
ALTER TABLE "app_user" ADD COLUMN "extra_permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
