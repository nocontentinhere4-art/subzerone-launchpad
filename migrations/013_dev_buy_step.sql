-- The dev buy as its own, second transaction (2026-10-12). create_v2 + the locked split + ATA + buy_v2 is 1242-1259
-- bytes in the Phantom-safe layout (event authorities written in), over the 1232 limit, so a launch WITH a dev buy is
-- two signatures: tx1 creates the coin (author + mint key, as before), tx2 is the author's ATA + buy_v2 on the now
-- existing curve (author only). launch.js createDevBuy / submitDevBuy / confirmDevBuy.
--
-- launch_intents.dev_buy_mode: NULL (no buy) | 'same_tx' (buy inside tx1, the old layout, only when it fits
-- Phantom-safe) | 'second_tx' (tx1 without the buy, tx2 after it is verified).
ALTER TABLE launch_intents ADD COLUMN dev_buy_mode TEXT;
-- launches.dev_buy_status: NULL (no buy, or bought inside tx1) | 'pending' (launched, waiting for the author's second
-- signature) | 'awaiting_signature' | 'submitted' | 'done' | 'failed' (the author may try again or skip) | 'skipped'.
-- "launched" never waits for it.
ALTER TABLE launches ADD COLUMN dev_buy_status TEXT;
ALTER TABLE launches ADD COLUMN dev_buy_lamports INTEGER NOT NULL DEFAULT 0;   -- the reviewed request, from the configuration
-- One row per tx2 attempt (a price that moved past the cap fails one attempt; the author may build a fresh one).
CREATE TABLE dev_buy_attempts (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  intent_id                TEXT NOT NULL REFERENCES launch_intents(id),
  mint                     TEXT NOT NULL,
  signer_wallet            TEXT NOT NULL,
  network                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('awaiting_signature','submitted','done','failed','expired','cancelled')),
  requested_lamports       INTEGER NOT NULL,
  cost_lamports            INTEGER,          -- the quote's real cost, fees included
  max_lamports             INTEGER,          -- the cap signed in buy_v2 (max_sol_cost)
  tokens_base              TEXT,             -- buy_v2 amount: exact-out, the ATA must receive exactly this
  tx_base64                TEXT,
  tx_message_hash          TEXT,
  tx_signature             TEXT UNIQUE,
  last_valid_block_height  INTEGER,
  estimate_json            TEXT,
  verification             TEXT,
  error                    TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX dev_buy_attempts_one_live ON dev_buy_attempts(project_id) WHERE status IN ('awaiting_signature','submitted');
