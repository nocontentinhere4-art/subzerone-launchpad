-- The dev buy's reviewed token amount (base units, from the provider's quote), stored with the intent so the on-chain
-- verification can check the author's token account holds exactly that (pump.fun buy_v2 is exact-out).
ALTER TABLE launch_intents ADD COLUMN buy_tokens_base TEXT;
