-- The idea app composer (composer.js, app-blocks.js, app-api.js, pq.js; docs/APP-COMPOSER.md), 2026-10-12. The app SPEC
-- lives in the site spec (site_versions.spec_json `app`); these tables hold what visitors add and what the app decided.
-- (013 is left to another branch.)

-- What visitors send through the app's form. `fields_json` is the moderated form ({key: value}); `text` its first field.
-- Visibility follows the app's flow (app-blocks.js exposure): board = public at once; inbox = private until published,
-- except the current round when the app puts it up for a vote. The IP is never stored, only a salted hash for the caps.
CREATE TABLE app_items (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  seq           INTEGER NOT NULL,             -- 1, 2, 3… per project (the receipt / ticket number)
  text          TEXT NOT NULL,
  fields_json   TEXT NOT NULL,
  wallet        TEXT,                         -- only when the visitor signed (holders-only forms)
  ip_hash       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  hidden_at     INTEGER,
  hidden_by     TEXT,
  published_at  INTEGER,                      -- revealed (the slot instant) or published by the owner
  published_by  TEXT,                         -- 'owner:<wallet>' | 'rule:votes' | 'rule:random' | 'owner-pick'
  UNIQUE (project_id, seq)
);
CREATE INDEX app_items_list ON app_items(project_id, created_at);
CREATE INDEX app_items_pub ON app_items(project_id, published_at);
CREATE INDEX app_items_ip ON app_items(project_id, ip_hash, created_at);

-- Signed votes. round = 'slot:<epoch ms>' (one vote per wallet per reveal) or 'item:<id>' (one per wallet per item).
CREATE TABLE app_votes (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  round       TEXT NOT NULL,
  item_id     TEXT NOT NULL REFERENCES app_items(id),
  wallet      TEXT NOT NULL,
  signature   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, round, wallet)
);
CREATE INDEX app_votes_item ON app_votes(project_id, item_id);

-- The owner's pick for an upcoming reveal (overrides votes and the draw).
CREATE TABLE app_picks (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  slot_at     INTEGER NOT NULL,
  item_id     TEXT NOT NULL REFERENCES app_items(id),
  picked_by   TEXT NOT NULL,
  picked_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, slot_at)
);

-- One row per scheduled reveal that ran: what was chosen, how, and the proof (the candidates, the votes, the seed:
-- a Solana slot's blockhash when the server can read the chain). method 'empty' = nothing to choose from.
CREATE TABLE app_reveals (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  slot_at     INTEGER NOT NULL,
  item_id     TEXT,
  method      TEXT NOT NULL CHECK (method IN ('owner','votes','random','empty')),
  proof_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  dev         INTEGER NOT NULL DEFAULT 0,     -- a reveal forced by the dev-only trigger (APP_DEV_TRIGGER=1), marked on the page
  PRIMARY KEY (project_id, slot_at)
);

-- The post-quantum registry (pq.js): one ML-DSA-65 key per project (the 32-byte seed, encrypted with APP_ENCRYPTION_KEY),
-- and a hash-chained, signed log of what the launchpad did for the coin.
CREATE TABLE pq_keys (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id),
  alg         TEXT NOT NULL,
  public_key  TEXT NOT NULL,                  -- base64
  seed_enc    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE pq_entries (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,                -- launch.config | fees.split | launch.mint | site.version | app.reveal | owner.note | registry.key
  ref           TEXT NOT NULL,                -- what it is about (a row id), unique per kind: the log is append-only
  at            INTEGER NOT NULL,
  payload_json  TEXT NOT NULL,                -- the exact bytes hashed
  message       TEXT NOT NULL,                -- the exact text signed
  hash          TEXT NOT NULL,                -- sha256(message), the next entry's `prev`
  signature     TEXT NOT NULL,                -- base64 ML-DSA-65 signature over message (UTF-8)
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, kind, ref)
);
