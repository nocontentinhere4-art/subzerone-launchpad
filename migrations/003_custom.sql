-- Customization (world.js): resident personality traits, room guestbooks, city events.

-- {neat, outgoing, active, playful, nice}, each 0..1 (validateTraits). NULL = all 0.5.
ALTER TABLE residents ADD COLUMN traits_json TEXT;

-- Visitors' notes in a room. Only the latest 50 per plot are kept. The wallet is never shown (the resident name is).
CREATE TABLE guestbook (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plot_id     TEXT NOT NULL,
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 80),
  created_at  INTEGER NOT NULL
);
CREATE INDEX guestbook_plot ON guestbook(plot_id, id);

-- Posting limits that survive pruning and deletions: posts per wallet, plot and UTC day; last post time per plot.
CREATE TABLE guestbook_quota (
  wallet      TEXT NOT NULL,
  plot_id     TEXT NOT NULL,
  day         TEXT NOT NULL,                   -- UTC yyyy-mm-dd
  n           INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (wallet, day, plot_id)
);

-- /api/world events: status changes of the last 24 hours
CREATE INDEX events_kind_at ON events(kind, at);
