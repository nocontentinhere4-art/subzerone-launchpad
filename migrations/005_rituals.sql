-- Daily rituals (rituals.js, diary.js): omikuji, build-or-pass predictions, ema (ideas pinned before the vote),
-- room visits for "while you were away", and the cached nightly diary. Nothing here has value or can be transferred:
-- fortunes and buffs are cosmetic, points only rank a leaderboard, cheers never reach the brain.

-- Ema: sha256 of JSON [title, concept, version, wallet] of version 1, fixed at submission (proof of priority).
-- NULL for ideas submitted before this migration.
ALTER TABLE ideas ADD COLUMN pinned_hash TEXT;
ALTER TABLE ideas ADD COLUMN pinned_at INTEGER;

-- Prediction points (+10 per correct guess) and visit tracking. away_since = when the resident left before the
-- current visit (a visit ends after 30 minutes without GET /api/me).
ALTER TABLE residents ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE residents ADD COLUMN last_seen_at INTEGER;
ALTER TABLE residents ADD COLUMN away_since INTEGER;

-- One omikuji per wallet per Tokyo day. buff is cosmetic: 'glow' | 'confetti' | 'petals' | 'none', until the day ends.
CREATE TABLE fortunes (
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  date        TEXT NOT NULL,                  -- Tokyo yyyy-mm-dd
  fortune     TEXT NOT NULL CHECK (fortune IN ('daikichi','chukichi','kichi','shokichi','hankichi','suekichi','kyo')),
  text        TEXT NOT NULL,                  -- one line from the fixed list (rituals.js FORTUNES)
  buff        TEXT NOT NULL CHECK (buff IN ('glow','confetti','petals','none')),
  until       INTEGER NOT NULL,               -- end of that Tokyo day (unix ms)
  drawn_at    INTEGER NOT NULL,
  PRIMARY KEY (wallet, date)
);
CREATE INDEX fortunes_date ON fortunes(date);

-- One guess per resident per public idea, made before the brain's answer. correct: NULL until settled.
CREATE TABLE predictions (
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  guess       TEXT NOT NULL CHECK (guess IN ('build','pass')),
  created_at  INTEGER NOT NULL,
  correct     INTEGER CHECK (correct IN (0,1)),
  settled_at  INTEGER,
  PRIMARY KEY (idea_id, wallet)
);

-- One cheer per resident per pinned idea. Cosmetic: not read by the pipeline or the brain.
CREATE TABLE ema_cheers (
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (idea_id, wallet)
);

-- Signed-in visitors of a room, one row per visitor per plot per Tokyo day (GET /api/rooms/:plotId).
CREATE TABLE room_visits (
  plot_id     TEXT NOT NULL,
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  day         TEXT NOT NULL,                  -- Tokyo yyyy-mm-dd
  at          INTEGER NOT NULL,
  PRIMARY KEY (plot_id, wallet, day)
);
CREATE INDEX room_visits_plot_at ON room_visits(plot_id, at);

-- SUB-01's diary for a finished Tokyo day. ideas_json: the ideas named in it (re-checked on every read: one made
-- private or declined since makes the page regenerate).
CREATE TABLE diary_days (
  date        TEXT PRIMARY KEY,
  body_json   TEXT NOT NULL,
  ideas_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
