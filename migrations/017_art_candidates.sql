-- Coin art candidates (coinart.js, 2026-10-12): every new coin gets two logo+banner pairs and its author picks one
-- (PUT /api/projects/:slug/art). The pairs are ordinary assets rows; the live pair stays "the newest version of each
-- kind", so every existing reader (sites, /meta, the city, the token metadata) is unchanged. Choosing copies the
-- chosen pair into new versions. Older coins have no rows here and keep their art.
CREATE TABLE art_candidates (
  project_id      TEXT NOT NULL REFERENCES projects(id),
  idx             INTEGER NOT NULL CHECK (idx IN (0, 1)),
  logo_asset_id   TEXT NOT NULL REFERENCES assets(id),
  banner_asset_id TEXT NOT NULL REFERENCES assets(id),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (project_id, idx)
);

-- The author's pick: NULL = never chose (option 1, idx 0, is live), else the idx of the live pair.
ALTER TABLE projects ADD COLUMN art_choice INTEGER;
