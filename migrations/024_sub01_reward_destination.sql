ALTER TABLE sub01_reward_claim_intents ADD COLUMN destination TEXT NOT NULL DEFAULT 'wallet' CHECK(destination IN ('wallet','buyback'));
