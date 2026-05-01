-- CreateTable
CREATE TABLE "brick_value_driver_options" (
    "id" SERIAL NOT NULL,
    "axis" TEXT NOT NULL,
    "option_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "brick_value_driver_options_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex: axis + option_key must be unique
CREATE UNIQUE INDEX "brick_value_driver_options_axis_option_key_key"
  ON "brick_value_driver_options"("axis", "option_key");

-- Seed default value driver options
INSERT INTO "brick_value_driver_options" ("axis", "option_key", "label", "display_order") VALUES
  ('A', 'rarity',      'Rarity / Scarcity',       1),
  ('A', 'collab',      'Collab / Artist Edition',  2),
  ('A', 'series',      'Series Exclusivity',       3),
  ('B', 'condition',   'Condition / Grading',      1),
  ('B', 'packaging',   'Original Packaging',       2),
  ('B', 'authenticity','Authenticity / Provenance',3),
  ('C', 'demand',      'Current Market Demand',    1),
  ('C', 'trend',       'Hype / Trend Driven',      2),
  ('C', 'media',       'Media / Cultural Moment',  3),
  ('D', 'size',        'Size Variant (100/400/1000%)', 1),
  ('D', 'colorway',    'Colorway Appeal',          2),
  ('D', 'design',      'Design / Aesthetic',       3);
