-- CreateEnum
CREATE TYPE "BrickStatus" AS ENUM ('UNRELEASED', 'PROTOTYPE', 'PUBLISHED');

-- CreateTable
CREATE TABLE "bricks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description_short" TEXT NOT NULL,
    "description_long" TEXT,
    "series" TEXT,
    "colorway" TEXT,
    "image_url" TEXT,
    "status" "BrickStatus" NOT NULL DEFAULT 'UNRELEASED',
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bricks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_brick_progress" (
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "stage1_at" TIMESTAMP(3),
    "stage2_at" TIMESTAMP(3),
    "stage3_at" TIMESTAMP(3),
    "vote_type" TEXT,
    "vote_event_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_brick_progress_pkey" PRIMARY KEY ("user_id","brick_id")
);

-- CreateTable
CREATE TABLE "context_sessions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "dwell_seconds" INTEGER NOT NULL DEFAULT 0,
    "scroll_pct" INTEGER NOT NULL DEFAULT 0,
    "interaction_seen" BOOLEAN NOT NULL DEFAULT false,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "context_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brick_value_drivers" (
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "option_key" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_value_drivers_pkey" PRIMARY KEY ("user_id","brick_id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "response_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "user_brick_progress_user_id_stage_idx" ON "user_brick_progress"("user_id", "stage");

-- CreateIndex
CREATE INDEX "user_brick_progress_brick_id_stage_idx" ON "user_brick_progress"("brick_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "context_sessions_idempotency_key_key" ON "context_sessions"("idempotency_key");

-- CreateIndex
CREATE INDEX "context_sessions_user_id_brick_id_idx" ON "context_sessions"("user_id", "brick_id");

-- CreateIndex
CREATE UNIQUE INDEX "brick_value_drivers_idempotency_key_key" ON "brick_value_drivers"("idempotency_key");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- AddForeignKey
ALTER TABLE "user_brick_progress" ADD CONSTRAINT "user_brick_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_brick_progress" ADD CONSTRAINT "user_brick_progress_brick_id_fkey" FOREIGN KEY ("brick_id") REFERENCES "bricks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_sessions" ADD CONSTRAINT "context_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_sessions" ADD CONSTRAINT "context_sessions_brick_id_fkey" FOREIGN KEY ("brick_id") REFERENCES "bricks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_value_drivers" ADD CONSTRAINT "brick_value_drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_value_drivers" ADD CONSTRAINT "brick_value_drivers_brick_id_fkey" FOREIGN KEY ("brick_id") REFERENCES "bricks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
