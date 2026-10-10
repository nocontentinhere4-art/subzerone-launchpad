-- Trust (trust.js, telemetry.js): the hash-chained vote ledger and anonymous client telemetry.

-- One row per brain answer (build AND pass, private ideas included), appended in the same transaction as the
-- evaluation. hash = sha256(prev_hash || canonical JSON of the public row); see trust.js and docs/CITY-API.md.
-- Append-only: the triggers refuse UPDATE and DELETE. The genesis prev_hash is 64 zeros.
CREATE TABLE vote_ledger (
  seq            INTEGER PRIMARY KEY,               -- 1, 2, 3 … without gaps
  at             INTEGER NOT NULL,                  -- unix ms, when the brain's answer was recorded
  idea_hash      TEXT NOT NULL,                     -- sha256 of JSON [title, concept, version]
  request_id     TEXT NOT NULL UNIQUE,              -- '<idea id>.v<version>' (= evaluations.brain_request_id); public only for public ideas
  decision       TEXT NOT NULL CHECK (decision IN ('build','pass')),
  networks_json  TEXT NOT NULL,
  vote_json      TEXT NOT NULL,                     -- the brain's vote record minus anything private (no labels, no titles)
  mood_json      TEXT,
  stage          TEXT,
  gain           REAL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE
);
CREATE TRIGGER vote_ledger_no_update BEFORE UPDATE ON vote_ledger BEGIN SELECT RAISE(ABORT, 'vote_ledger is append-only'); END;
CREATE TRIGGER vote_ledger_no_delete BEFORE DELETE ON vote_ledger BEGIN SELECT RAISE(ABORT, 'vote_ledger is append-only'); END;
CREATE INDEX evaluations_request ON evaluations(brain_request_id);

-- Anonymous performance reports from the city client. No wallet, no IP: the session id and the IP are stored only as
-- sha256 with a per-UTC-day salt that is replaced (and so destroyed) at the first report of the next day; the IP hash
-- is then cleared too. Rows older than 90 days are deleted at the same moment.
CREATE TABLE telemetry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL,                     -- UTC yyyy-mm-dd
  at             INTEGER NOT NULL,
  session_hash   TEXT NOT NULL,
  ip_hash        TEXT,                              -- for the 500/day cap only; NULL after the day ends
  device         TEXT NOT NULL CHECK (device IN ('phone','desktop')),
  gpu_class      TEXT CHECK (gpu_class IN ('weak','ok')),
  quality_level  INTEGER NOT NULL CHECK (quality_level BETWEEN 0 AND 3),
  fps_bucket     TEXT NOT NULL CHECK (fps_bucket IN ('<20','20-30','30-45','45+')),
  crash          INTEGER NOT NULL CHECK (crash IN (0,1)),
  context_lost   INTEGER NOT NULL CHECK (context_lost IN (0,1)),
  memory_mb      INTEGER,
  seconds        INTEGER NOT NULL
);
CREATE INDEX telemetry_day_ip ON telemetry(day, ip_hash);
CREATE INDEX telemetry_session ON telemetry(session_hash, at);
