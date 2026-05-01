-- CreateTable
CREATE TABLE "dex_event_log" (
    "id" BIGSERIAL NOT NULL,
    "event_type" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "brick_id" TEXT NOT NULL,
    "from_stage" INTEGER,
    "to_stage" INTEGER,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dex_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dex_event_log_brick_id_created_at_idx" ON "dex_event_log"("brick_id", "created_at");

-- CreateIndex
CREATE INDEX "dex_event_log_user_id_created_at_idx" ON "dex_event_log"("user_id", "created_at");
