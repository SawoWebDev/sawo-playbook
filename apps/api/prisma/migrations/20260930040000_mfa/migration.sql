-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "mfa_last_step" INTEGER,
ADD COLUMN     "mfa_pending_secret_enc" TEXT,
ADD COLUMN     "mfa_secret_enc" TEXT;

