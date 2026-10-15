-- The two-step launch (2026-10-15, LAUNCH_SPLIT_TX=1, the default). Phantom shows "This dApp could be malicious" on
-- the single creation transaction (create_v2 + the fee-sharing config + the locked shares, a second signer, ~910
-- bytes). It is now split in two: tx1 = create_v2 ONLY (the author + the mint key, as before); tx2 = sweep_creator_fee
-- + create_fee_sharing_config + update_fee_shares_v2 (the exact approved split, locked) and, when it fits Phantom-safe,
-- the dev buy (ATA + buy_v2), signed by the author's wallet ALONE, built with a fresh blockhash right after tx1 is
-- confirmed. launch.js createSplit / submitSplit / confirmSplit / recheckSplit.
--
-- launch_intents.split_tx: 1 = this intent is tx1 of a two-step launch (no fee-sharing instruction in it).
ALTER TABLE launch_intents ADD COLUMN split_tx INTEGER NOT NULL DEFAULT 0;
-- launches.split_state: NULL (single-transaction launch: the split was locked in tx1, or there is no split) |
-- 'pending' (the coin exists on chain, the fee split is NOT locked yet: step 2 waits for the author) |
-- 'awaiting_signature' | 'submitted' | 'failed' (the last tx2 did not go through; the author may try again) |
-- 'locked' (verified on chain: the sharing config holds exactly the approved shares, admin revoked) |
-- 'mismatch' (a sharing config exists on chain with OTHER shares, or not locked: an admin must look; never retried).
ALTER TABLE launches ADD COLUMN split_state TEXT;
ALTER TABLE launches ADD COLUMN split_locked_at INTEGER;
ALTER TABLE launches ADD COLUMN split_checked_at INTEGER;       -- the last on-chain recheck (worker split_recheck)
ALTER TABLE launches ADD COLUMN split_reminded_at INTEGER;      -- the last reminder note to the author
ALTER TABLE launches ADD COLUMN split_detail TEXT;              -- JSON: what the chain showed on a mismatch, or the lock's checks
-- One row per tx2 attempt (a price that moved past the buy's cap fails one attempt; the author builds a fresh one).
CREATE TABLE split_attempts (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  intent_id                TEXT NOT NULL REFERENCES launch_intents(id),
  mint                     TEXT NOT NULL,
  signer_wallet            TEXT NOT NULL,
  network                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('awaiting_signature','submitted','done','failed','expired','cancelled')),
  shares_json              TEXT NOT NULL,      -- [{wallet, bps}] the exact shareholders this tx2 writes (re-checked server side)
  with_buy                 INTEGER NOT NULL DEFAULT 0,   -- 1: the dev buy (ATA + buy_v2) rides in this tx2
  requested_lamports       INTEGER NOT NULL DEFAULT 0,
  cost_lamports            INTEGER,
  max_lamports             INTEGER,
  tokens_base              TEXT,
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
CREATE UNIQUE INDEX split_attempts_one_live ON split_attempts(project_id) WHERE status IN ('awaiting_signature','submitted');
CREATE INDEX launches_split_state ON launches(split_state);
