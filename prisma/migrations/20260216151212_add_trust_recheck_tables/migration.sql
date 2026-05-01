-- CreateEnum
CREATE TYPE "TrustTier" AS ENUM ('UNTRUSTED', 'PROBATION', 'NEUTRAL', 'RELIABLE', 'PROVEN');

-- CreateEnum
CREATE TYPE "CycleOutcome" AS ENUM ('UP', 'DOWN', 'FLAT');

-- CreateEnum
CREATE TYPE "TrustWorkerJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "brick_price_state" ADD COLUMN     "recheck_expires_at" TIMESTAMP(3),
ADD COLUMN     "recheck_reason" TEXT,
ADD COLUMN     "recheck_started_at" TIMESTAMP(3),
ADD COLUMN     "recheck_state" TEXT NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "user_brick_vote_credits" ADD COLUMN     "last_recheck_credit_grant_at" TIMESTAMP(3),
ADD COLUMN     "last_recheck_credit_grant_cycle" TEXT;

-- CreateTable
CREATE TABLE "pricing_cycle_close_events" (
    "id" BIGSERIAL NOT NULL,
    "brick_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "cycle_start_price" DECIMAL(12,2) NOT NULL,
    "cycle_end_price" DECIMAL(12,2) NOT NULL,
    "outcome" "CycleOutcome" NOT NULL,
    "unique_voters" INTEGER NOT NULL,
    "weighted_total_at_close" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_cycle_close_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brick_freeze_window_events" (
    "id" BIGSERIAL NOT NULL,
    "brick_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "freeze_entered_at" TIMESTAMP(3) NOT NULL,
    "freeze_exited_at" TIMESTAMP(3),
    "entry_weighted_total" DOUBLE PRECISION NOT NULL,
    "exit_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_freeze_window_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_trust_state" (
    "user_id" BIGINT NOT NULL,
    "trust_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "trust_tier" "TrustTier" NOT NULL DEFAULT 'UNTRUSTED',
    "total_scored_votes" INTEGER NOT NULL DEFAULT 0,
    "aligned_votes" INTEGER NOT NULL DEFAULT 0,
    "misaligned_votes" INTEGER NOT NULL DEFAULT 0,
    "abuse_flag_count" INTEGER NOT NULL DEFAULT 0,
    "cooldown_until" TIMESTAMP(3),
    "last_scored_at" TIMESTAMP(3),
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_trust_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "trust_score_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "cycle_close_event_id" BIGINT NOT NULL,
    "vote_event_id" BIGINT NOT NULL,
    "vote_type" "VoteType" NOT NULL,
    "aligned" BOOLEAN NOT NULL,
    "user_weight_at_vote" DOUBLE PRECISION NOT NULL,
    "vote_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trust_score_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trust_worker_jobs" (
    "id" BIGSERIAL NOT NULL,
    "cycle_close_event_id" BIGINT NOT NULL,
    "status" "TrustWorkerJobStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trust_worker_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_cycle_close_events_cycle_id_idx" ON "pricing_cycle_close_events"("cycle_id");

-- CreateIndex
CREATE INDEX "pricing_cycle_close_events_closed_at_idx" ON "pricing_cycle_close_events"("closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_cycle_close_events_brick_id_cycle_id_key" ON "pricing_cycle_close_events"("brick_id", "cycle_id");

-- CreateIndex
CREATE INDEX "brick_freeze_window_events_brick_id_freeze_entered_at_freez_idx" ON "brick_freeze_window_events"("brick_id", "freeze_entered_at", "freeze_exited_at");

-- CreateIndex
CREATE INDEX "user_trust_state_trust_tier_idx" ON "user_trust_state"("trust_tier");

-- CreateIndex
CREATE INDEX "user_trust_state_cooldown_until_idx" ON "user_trust_state"("cooldown_until");

-- CreateIndex
CREATE UNIQUE INDEX "trust_score_events_vote_event_id_key" ON "trust_score_events"("vote_event_id");

-- CreateIndex
CREATE INDEX "trust_score_events_user_id_created_at_idx" ON "trust_score_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "trust_score_events_cycle_id_idx" ON "trust_score_events"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "trust_score_events_user_id_brick_id_cycle_id_key" ON "trust_score_events"("user_id", "brick_id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "trust_worker_jobs_cycle_close_event_id_key" ON "trust_worker_jobs"("cycle_close_event_id");

-- CreateIndex
CREATE INDEX "trust_worker_jobs_status_created_at_idx" ON "trust_worker_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "pricing_cycle_close_events" ADD CONSTRAINT "pricing_cycle_close_events_brick_id_fkey" FOREIGN KEY ("brick_id") REFERENCES "brick_price_state"("brick_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_freeze_window_events" ADD CONSTRAINT "brick_freeze_window_events_brick_id_fkey" FOREIGN KEY ("brick_id") REFERENCES "brick_price_state"("brick_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_trust_state" ADD CONSTRAINT "user_trust_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_cycle_close_event_id_fkey" FOREIGN KEY ("cycle_close_event_id") REFERENCES "pricing_cycle_close_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_vote_event_id_fkey" FOREIGN KEY ("vote_event_id") REFERENCES "vote_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_worker_jobs" ADD CONSTRAINT "trust_worker_jobs_cycle_close_event_id_fkey" FOREIGN KEY ("cycle_close_event_id") REFERENCES "pricing_cycle_close_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
