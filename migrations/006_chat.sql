-- Live city chat (chat.js): residents' messages, their messages to SUB-01 and SUB-01's relayed replies. Kept 7 days
-- (pruned on every insert). `wallet` is the poster's, used for quotas and moderation only: it never leaves the
-- admin routes. SUB-01's rows have no wallet.
CREATE TABLE chat_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('resident','sub01','system')),
  wallet           TEXT REFERENCES users(wallet),
  name             TEXT NOT NULL,                -- the resident's name at posting time, or 'SUB-01'
  text             TEXT NOT NULL,
  district         TEXT,
  plot_id          TEXT,
  to_sub01         INTEGER NOT NULL DEFAULT 0 CHECK (to_sub01 IN (0,1)),   -- a resident's message forwarded to SUB-01
  replying_to_json TEXT,                         -- sub01 rows: {id, name, text} of the message he answered
  dedupe_key       TEXT,
  reports          INTEGER NOT NULL DEFAULT 0,
  reported_at      INTEGER
);
CREATE INDEX chat_messages_at ON chat_messages(at);
CREATE INDEX chat_messages_wallet ON chat_messages(wallet, at);

-- One report per wallet per message.
CREATE TABLE chat_reports (
  message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  wallet      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (message_id, wallet)
);
