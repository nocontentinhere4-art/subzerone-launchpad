-- SUBZERONE launchpad, schema v1. Times are unix milliseconds (INTEGER). JSON columns hold structured stage I/O.

CREATE TABLE users (
  wallet      TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','reviewer','admin')),
  created_at  INTEGER NOT NULL,
  banned_at   INTEGER
);

-- Sign-in: one nonce per message, single use, short-lived.
CREATE TABLE auth_nonces (
  nonce       TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  message     TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX auth_nonces_exp ON auth_nonces(expires_at);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,           -- sha256 of the cookie value; the value itself is never stored
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE ideas (
  id               TEXT PRIMARY KEY,
  owner_wallet     TEXT NOT NULL REFERENCES users(wallet),
  status           TEXT NOT NULL,
  status_note      TEXT,                  -- human-readable reason for the current status
  visibility       TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  published_at     INTEGER,
  current_version  INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX ideas_owner ON ideas(owner_wallet);
CREATE INDEX ideas_status ON ideas(status);

-- Every edit is a new row. Version 1 is the original submission, kept as submitted.
CREATE TABLE idea_versions (
  id                TEXT PRIMARY KEY,
  idea_id           TEXT NOT NULL REFERENCES ideas(id),
  version           INTEGER NOT NULL,
  title             TEXT NOT NULL,
  concept           TEXT NOT NULL,
  name_suggestion   TEXT,
  ticker_suggestion TEXT,
  links_json        TEXT NOT NULL DEFAULT '[]',   -- stored as text, never fetched by the server
  contacts_json     TEXT NOT NULL DEFAULT '{}',
  receiving_wallet  TEXT NOT NULL,
  rights_confirmed  INTEGER NOT NULL CHECK (rights_confirmed = 1),
  authored_by       TEXT NOT NULL,                -- the authenticated wallet that wrote this version
  content_hash      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (idea_id, version)
);

CREATE TABLE uploads (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  sha256      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (idea_id, sha256)
);

CREATE TABLE evaluations (
  id                 TEXT PRIMARY KEY,
  idea_id            TEXT NOT NULL REFERENCES ideas(id),
  idea_version       INTEGER NOT NULL,
  scorecard_version  TEXT NOT NULL,
  brain_request_id   TEXT NOT NULL,
  brain_json         TEXT NOT NULL,          -- the brain service's full record (vote, networks, mood, network used)
  scores_json        TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('selected','declined')),
  decided_by         TEXT NOT NULL,          -- 'brain_vote' | 'policy:<rule>'
  created_at         INTEGER NOT NULL,
  UNIQUE (idea_id, idea_version)
);

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  idea_id               TEXT NOT NULL UNIQUE REFERENCES ideas(id),
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  ticker                TEXT NOT NULL,
  description           TEXT NOT NULL,
  live_site_version     INTEGER,             -- the version served on the project subdomain
  submitter_approved_at INTEGER,
  admin_cleared_at      INTEGER,
  admin_cleared_by      TEXT,
  launch_config_json    TEXT,                -- the reviewed launch configuration (prepare_launch output)
  launch_config_hash    TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE generations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  version     INTEGER NOT NULL,
  generator   TEXT NOT NULL,                 -- 'template/1' or 'anthropic:<model>'
  input_json  TEXT NOT NULL,
  output_json TEXT NOT NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE assets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  kind        TEXT NOT NULL CHECK (kind IN ('logo','banner')),
  version     INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  body        BLOB NOT NULL,
  sha256      TEXT NOT NULL,
  generator   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, kind, version)
);

CREATE TABLE site_versions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  version      INTEGER NOT NULL,
  spec_json    TEXT NOT NULL,                -- editable content; the only input of the sandboxed build
  build_status TEXT NOT NULL CHECK (build_status IN ('pending','ok','rejected','failed')),
  build_report TEXT,
  html         TEXT,
  sha256       TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE x_accounts (
  project_id      TEXT PRIMARY KEY REFERENCES projects(id),
  planned_handle  TEXT NOT NULL,
  planned_bio     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('planned','connected','revoked')),
  x_user_id       TEXT,
  x_handle        TEXT,                      -- as reported by X after OAuth; never assumed
  access_enc      TEXT,
  refresh_enc     TEXT,
  expires_at      INTEGER,
  connected_at    INTEGER,
  connected_by    TEXT
);

CREATE TABLE x_posts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','approved','publishing','published','failed')),
  approved_by  TEXT,
  approved_at  INTEGER,
  x_post_id    TEXT UNIQUE,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  wallet        TEXT NOT NULL,
  verifier_enc  TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);

-- Fee allocation: versioned; the approved version is what the launch config uses.
CREATE TABLE fee_allocations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  version            INTEGER NOT NULL,
  recipients_json    TEXT NOT NULL,         -- [{label, wallet, bps, role}]
  total_bps          INTEGER NOT NULL CHECK (total_bps = 10000),
  status             TEXT NOT NULL CHECK (status IN ('draft','approved','superseded','locked')),
  approved_by        TEXT,
  approved_at        INTEGER,
  approval_statement TEXT,                  -- the exact text the submitter accepted
  created_at         INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

-- A launch intent exists before any signature is requested. At most one live intent per project.
CREATE TABLE launch_intents (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  provider                 TEXT NOT NULL,
  network                  TEXT NOT NULL,
  config_json              TEXT NOT NULL,
  config_hash              TEXT NOT NULL,
  allocation_id            TEXT NOT NULL REFERENCES fee_allocations(id),
  mint                     TEXT NOT NULL UNIQUE,
  mint_secret_enc          TEXT,             -- provider-generated mint key, deleted once launched/abandoned
  signer_wallet            TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN
                             ('prepared','awaiting_signature','submitted','confirmed','failed','expired','cancelled')),
  tx_base64                TEXT,             -- the exact unsigned transaction shown for review
  tx_message_hash          TEXT,
  tx_signature             TEXT UNIQUE,
  last_valid_block_height  INTEGER,
  error                    TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX launch_intents_one_live ON launch_intents(project_id)
  WHERE status IN ('prepared','awaiting_signature','submitted','confirmed');

CREATE TABLE launches (
  project_id     TEXT PRIMARY KEY REFERENCES projects(id),
  intent_id      TEXT NOT NULL UNIQUE REFERENCES launch_intents(id),
  provider       TEXT NOT NULL,
  network        TEXT NOT NULL,
  mint           TEXT NOT NULL UNIQUE,
  tx_signature   TEXT NOT NULL UNIQUE,
  slot           INTEGER,
  block_time     INTEGER,
  verification   TEXT NOT NULL,             -- what was checked on-chain, and the result
  verified_at    INTEGER NOT NULL
);

-- On-chain observations only. Each row cites a transaction or an account read at a slot.
CREATE TABLE fee_observations (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  kind          TEXT NOT NULL CHECK (kind IN ('vault_balance','claim','distribution','payout')),
  account       TEXT,
  recipient     TEXT,
  lamports      INTEGER NOT NULL,
  tx_signature  TEXT,
  slot          INTEGER,
  block_time    INTEGER,
  source        TEXT NOT NULL,              -- rpc endpoint label, or 'mock'
  observed_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX fee_obs_tx ON fee_observations(kind, tx_signature, recipient) WHERE tx_signature IS NOT NULL;

-- Durable job queue.
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  idea_id          TEXT,
  project_id       TEXT,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','dead','cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL,
  timeout_ms       INTEGER NOT NULL,
  run_after        INTEGER NOT NULL,
  lease_until      INTEGER,
  locked_by        TEXT,
  progress         TEXT,                    -- human-readable
  last_error       TEXT,
  result_json      TEXT,
  cost_usd         REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX jobs_ready ON jobs(status, run_after);

-- Audit trail and public timeline. public=1 rows appear on a published idea's timeline.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,                -- 'wallet:<addr>' | 'admin:<addr>' | 'system' | 'brain' | 'generator'
  idea_id     TEXT,
  project_id  TEXT,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  data_json   TEXT,
  public      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_idea ON events(idea_id, at);

CREATE TABLE spend (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,                -- UTC yyyy-mm-dd
  project_id  TEXT,
  kind        TEXT NOT NULL,
  usd         REAL NOT NULL,
  job_id      TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX spend_day ON spend(day);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE market_cache (
  key         TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  source      TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

-- The mock launch provider's ledger: a stand-in for the chain in tests and local demos. Never shown as on-chain.
CREATE TABLE mock_chain (
  signature   TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,
  visible_at  INTEGER NOT NULL              -- simulated indexing delay
);
