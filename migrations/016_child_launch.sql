-- Child launches (child-launch.js, docs/APP-COMPOSER.md "The launch block"), 2026-10-12. A coin site whose app has a
-- `launch` block lets visitors create REAL coins there. Each one is an ordinary SUBZERONE idea + project (its own
-- building, its own site, SUB-01's vote first, the same launch machinery) with a link to the parent project, and a
-- fee split locked on-chain: creator / the parent's author / SUB-01. (015 is left to another branch.)

-- The parent of a coin launched from another coin's site. NULL for every coin launched through the city.
ALTER TABLE projects ADD COLUMN parent_project_id TEXT REFERENCES projects(id);
CREATE INDEX projects_parent ON projects(parent_project_id);

-- What the visitor asked for, exactly as they signed it (the start message), kept until the project exists and after.
-- The project row is created when SUB-01 votes build (job child_build); idea_id links the two. key_hash: sha256 of the
-- launch key the page holds (no sessions on coin sites); the transaction steps need it, the wallet signs anyway.
CREATE TABLE child_launches (
  id                    TEXT PRIMARY KEY,
  parent_project_id     TEXT NOT NULL REFERENCES projects(id),
  idea_id               TEXT NOT NULL UNIQUE REFERENCES ideas(id),
  wallet                TEXT NOT NULL,
  key_hash              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  ticker                TEXT NOT NULL,
  description           TEXT NOT NULL,
  image_mime            TEXT NOT NULL,
  image                 BLOB NOT NULL,
  image_sha256          TEXT NOT NULL,
  initial_buy_lamports  INTEGER NOT NULL DEFAULT 0,
  recipients_json       TEXT NOT NULL,              -- [{label, wallet, bps, role}] creator / parent / sub01
  statement             TEXT NOT NULL,              -- the allocation statement (launch.js allocationStatement)
  message               TEXT NOT NULL,              -- the exact text the wallet signed
  signature             TEXT NOT NULL,
  ip_hash               TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX child_launches_parent ON child_launches(parent_project_id, created_at);
CREATE INDEX child_launches_ip ON child_launches(parent_project_id, ip_hash, created_at);
