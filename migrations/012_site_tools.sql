-- The site kit's tool data (tools.js, tool-api.js, docs/SITE-KIT.md), 2026-10-12. Tool CONFIG lives in the site spec
-- (site_versions.spec_json `tools`); these tables hold what visitors add. Everything is keyed by project.

-- Wall notes, drop-box submissions and map pins. `wallet` only when the visitor signed (holders-only modes); the IP is
-- never stored, only a salted hash for the per-day caps. Drop submissions are private until featured.
CREATE TABLE tool_entries (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  tool         TEXT NOT NULL CHECK (tool IN ('wall','drop','map')),
  text         TEXT NOT NULL,
  data_json    TEXT,                          -- map pins: {"lat":…, "lng":…}
  wallet       TEXT,
  ip_hash      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  hidden_at    INTEGER,                       -- the author (or an admin) hid it
  hidden_by    TEXT,
  featured_at  INTEGER,                       -- drop: shown on the site ("today's pick")
  featured_by  TEXT                           -- 'wallet:<author>' or 'rule:daily'
);
CREATE INDEX tool_entries_list ON tool_entries(project_id, tool, created_at);
CREATE INDEX tool_entries_ip ON tool_entries(project_id, tool, ip_hash, created_at);

-- One signed vote per wallet per poll. poll_key = hash of the question and answers: editing the poll starts a new count.
CREATE TABLE poll_votes (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  poll_key    TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  choice      INTEGER NOT NULL CHECK (choice BETWEEN 0 AND 3),
  signature   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, poll_key, wallet)
);

-- Single-use messages a visitor's wallet signs on a coin site (no sessions or cookies on project hosts): issued by
-- POST /_api/sign, burned by the write that carries the signature. payload_hash binds the message to the exact write.
CREATE TABLE tool_nonces (
  nonce         TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  wallet        TEXT NOT NULL,
  action        TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  message       TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX tool_nonces_expiry ON tool_nonces(expires_at);

-- Price / market-cap samples of launched coins (coin-stats.js writes one per good refresh), for the token panel's
-- sparkline and the chart tool. Kept 8 days.
CREATE TABLE coin_samples (
  mint            TEXT NOT NULL,
  at              INTEGER NOT NULL,
  price_usd       REAL,
  market_cap_usd  REAL,
  PRIMARY KEY (mint, at)
);
