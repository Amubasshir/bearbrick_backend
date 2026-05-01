-- CreateTable
CREATE TABLE "brick_families" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "cover_image_url" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_families_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "brick_families_slug_key" ON "brick_families"("slug");

-- AlterTable: add familyId to bricks
ALTER TABLE "bricks" ADD COLUMN "family_id" TEXT;

-- AddForeignKey
ALTER TABLE "bricks" ADD CONSTRAINT "bricks_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "brick_families"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
