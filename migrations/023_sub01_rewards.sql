CREATE TABLE sub01_reward_epochs (
  epoch_id INTEGER PRIMARY KEY CHECK(epoch_id >= 0),
  root TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL
);
CREATE TABLE sub01_reward_claim_intents (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  epoch_id INTEGER NOT NULL REFERENCES sub01_reward_epochs(epoch_id),
  amount_lamports TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  signature TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sub01_reward_claim_wallet ON sub01_reward_claim_intents(wallet, created_at);
