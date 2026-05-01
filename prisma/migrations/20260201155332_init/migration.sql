-- CreateEnum
CREATE TYPE "VoteType" AS ENUM ('UNDER', 'FAIR', 'OVER');

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('PENDING', 'PROCESSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "XpReason" AS ENUM ('VOTE', 'STREAK', 'RECHECK', 'ACCURACY');

-- CreateTable
CREATE TABLE "User" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_intents" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "vote_type" "VoteType" NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'PENDING',
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "processed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "vote_event_id" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "vote_type" "VoteType" NOT NULL,
    "live_price_at_vote" DECIMAL(12,2) NOT NULL,
    "fair_range_lower" DECIMAL(12,2) NOT NULL,
    "fair_range_upper" DECIMAL(12,2) NOT NULL,
    "base_step_at_vote" INTEGER NOT NULL,
    "user_weight_at_vote" DOUBLE PRECISION NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "vote_intent_id" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xp_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "vote_event_id" BIGINT,
    "brick_id" TEXT NOT NULL,
    "xp_amount" INTEGER NOT NULL,
    "reason" "XpReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brick_price_state" (
    "brick_id" TEXT NOT NULL,
    "baseline_price" DECIMAL(12,2),
    "live_price" DECIMAL(12,2) NOT NULL,
    "current_cycle_id" TEXT NOT NULL,
    "weighted_under" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weighted_fair" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weighted_over" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weighted_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weighted_since_last_move" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "p_under" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "p_fair" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "p_over" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricing_confidence_c" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reliability_score_r" DOUBLE PRECISION,
    "momentum_score" INTEGER NOT NULL DEFAULT 0,
    "last_price_update" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_high_confidence_price" DECIMAL(12,2),
    "last_high_confidence_votes" DOUBLE PRECISION,
    "last_confidence_timestamp" TIMESTAMP(3),
    "needs_recheck" BOOLEAN NOT NULL DEFAULT false,
    "freeze_mode" BOOLEAN NOT NULL DEFAULT false,
    "freeze_until" TIMESTAMP(3),
    "cycle_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle_start_price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_price_state_pkey" PRIMARY KEY ("brick_id")
);

-- CreateTable
CREATE TABLE "brick_price_history" (
    "id" BIGSERIAL NOT NULL,
    "brick_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "close_price" DECIMAL(12,2) NOT NULL,
    "votes_that_day" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_brick_vote_credits" (
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "credits_remaining" INTEGER NOT NULL DEFAULT 3,
    "last_vote_price" DECIMAL(12,2),
    "last_vote_cycle_id" TEXT,
    "last_vote_at" TIMESTAMP(3),
    "last_credit_regain_price" DECIMAL(12,2),
    "last_credit_regain_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_brick_vote_credits_pkey" PRIMARY KEY ("user_id","brick_id")
);

-- CreateTable
CREATE TABLE "user_identity_state" (
    "user_id" BIGINT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "trust_tier" INTEGER NOT NULL DEFAULT 0,
    "behavior_state" TEXT NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identity_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "worker_cursors" (
    "worker_name" TEXT NOT NULL,
    "last_processed_id" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_cursors_pkey" PRIMARY KEY ("worker_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "vote_intents_vote_event_id_key" ON "vote_intents"("vote_event_id");

-- CreateIndex
CREATE INDEX "vote_intents_userId_createdAt_idx" ON "vote_intents"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "vote_intents_status_createdAt_idx" ON "vote_intents"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "vote_events_vote_intent_id_key" ON "vote_events"("vote_intent_id");

-- CreateIndex
CREATE INDEX "vote_events_brick_id_createdAt_idx" ON "vote_events"("brick_id", "createdAt");

-- CreateIndex
CREATE INDEX "vote_events_brick_id_cycle_id_idx" ON "vote_events"("brick_id", "cycle_id");

-- CreateIndex
CREATE INDEX "vote_events_user_id_brick_id_createdAt_idx" ON "vote_events"("user_id", "brick_id", "createdAt");

-- CreateIndex
CREATE INDEX "xp_events_user_id_createdAt_idx" ON "xp_events"("user_id", "createdAt");

-- CreateIndex
CREATE INDEX "brick_price_history_brick_id_date_idx" ON "brick_price_history"("brick_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "brick_price_history_brick_id_date_key" ON "brick_price_history"("brick_id", "date");

-- CreateIndex
CREATE INDEX "user_brick_vote_credits_brick_id_idx" ON "user_brick_vote_credits"("brick_id");

-- AddForeignKey
ALTER TABLE "vote_intents" ADD CONSTRAINT "vote_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_intents" ADD CONSTRAINT "vote_intents_vote_event_id_fkey" FOREIGN KEY ("vote_event_id") REFERENCES "vote_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_events" ADD CONSTRAINT "vote_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_events" ADD CONSTRAINT "vote_events_vote_intent_id_fkey" FOREIGN KEY ("vote_intent_id") REFERENCES "vote_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_vote_event_id_fkey" FOREIGN KEY ("vote_event_id") REFERENCES "vote_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_brick_vote_credits" ADD CONSTRAINT "user_brick_vote_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identity_state" ADD CONSTRAINT "user_identity_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
