CREATE TABLE sub01_reward_funding_intents (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  epoch_id INTEGER NOT NULL CHECK(epoch_id = 100000),
  input_json TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  signature TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sub01_reward_funding_wallet ON sub01_reward_funding_intents(wallet, created_at);
