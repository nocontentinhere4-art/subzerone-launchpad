-- Per-mint market and holder stats of launched projects (coin-stats.js): the honest data feed behind the city's
-- building lights. One row per mint. `json` is the LAST GOOD stats object (every number carries its source and time);
-- a failed refresh keeps it and only sets ok = 0 + error, so a stale value is still shown, flagged fresh: false.
CREATE TABLE coin_stats (
  mint        TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,             -- when `json` was fetched (the last good fetch)
  checked_at  INTEGER NOT NULL,             -- the last attempt, good or not
  ok          INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  error       TEXT
);
