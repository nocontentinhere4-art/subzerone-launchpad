-- The author's optional "dev buy": lamports of SOL spent on their own coin inside the creation transaction
-- (launch.js setInitialBuy, PUT /api/projects/:slug/launch/options). 0 = no buy. Capped by MAX_INITIAL_BUY_SOL,
-- never above 5 SOL. The value is copied into the reviewed launch configuration (initialBuyLamports) when it is prepared.
ALTER TABLE projects ADD COLUMN initial_buy_lamports INTEGER NOT NULL DEFAULT 0;
