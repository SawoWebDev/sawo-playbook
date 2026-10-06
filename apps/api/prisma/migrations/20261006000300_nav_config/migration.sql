-- Admin-customisable sidebar menu (order and which items are shown). Null keeps the built-in menu.
-- Additive and non-destructive: existing rows get NULL.
ALTER TABLE "organization_settings" ADD COLUMN "nav_config" JSONB;
