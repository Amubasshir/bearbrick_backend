-- AlterEnum
ALTER TYPE "XpReason" ADD VALUE 'DEX_STAGE1';
ALTER TYPE "XpReason" ADD VALUE 'DEX_STAGE3';
ALTER TYPE "XpReason" ADD VALUE 'DEX_STREAK';

-- AlterTable: add isAdmin to users
ALTER TABLE "User" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: add streak fields to user_identity_state
ALTER TABLE "user_identity_state"
  ADD COLUMN "streak_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_activity_date" DATE;
