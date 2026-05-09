ALTER TABLE bricks
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description_short,'')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_bricks_search ON bricks USING GIN (search_tsv);
