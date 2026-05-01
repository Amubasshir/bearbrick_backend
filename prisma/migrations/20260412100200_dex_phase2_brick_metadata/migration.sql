-- AlterTable: add metadata fields to bricks
ALTER TABLE "bricks"
  ADD COLUMN "thumbnail_url" TEXT,
  ADD COLUMN "edition_size" INTEGER,
  ADD COLUMN "retail_price" DECIMAL(12, 2),
  ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex: fast lookup for featured bricks
CREATE INDEX "bricks_featured_idx" ON "bricks"("featured") WHERE "featured" = true;
