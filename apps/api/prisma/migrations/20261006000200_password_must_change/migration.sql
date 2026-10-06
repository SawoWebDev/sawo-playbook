-- Admin-created accounts with a temporary password must set their own password at first sign-in.
-- Additive and non-destructive: existing rows default to false (no forced change).
ALTER TABLE "app_user" ADD COLUMN "password_must_change" BOOLEAN NOT NULL DEFAULT false;
