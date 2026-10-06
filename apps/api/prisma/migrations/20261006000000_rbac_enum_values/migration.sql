-- Enum values must be committed before they are used (the next migration references them in a partial index).
ALTER TYPE "OrgRole" ADD VALUE IF NOT EXISTS 'PRE_APPROVER';
ALTER TYPE "VersionLifecycleState" ADD VALUE IF NOT EXISTS 'PENDING_PRE_APPROVAL';
