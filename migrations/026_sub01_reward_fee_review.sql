ALTER TABLE sub01_reward_funding_intents ADD COLUMN transaction_b64 TEXT;
ALTER TABLE sub01_reward_funding_intents ADD COLUMN base_network_fee_lamports TEXT;
ALTER TABLE sub01_reward_funding_intents ADD COLUMN max_network_fee_lamports TEXT;
ALTER TABLE sub01_reward_claim_intents ADD COLUMN transaction_b64 TEXT;
ALTER TABLE sub01_reward_claim_intents ADD COLUMN base_network_fee_lamports TEXT;
ALTER TABLE sub01_reward_claim_intents ADD COLUMN max_network_fee_lamports TEXT;
