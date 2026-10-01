-- Three working roles: Admin, Editor, Viewer (OPERATOR) — plus the account Owner.
-- The retired Approver and Trainer roles become Editor (Editors now create, edit, approve and publish).
-- The enum values stay so historical rows and audit entries remain valid; the API no longer assigns them.
UPDATE "app_user"   SET "org_role" = 'EDITOR' WHERE "org_role" IN ('APPROVER', 'TRAINER');
UPDATE "invitation" SET "org_role" = 'EDITOR' WHERE "org_role" IN ('APPROVER', 'TRAINER');
