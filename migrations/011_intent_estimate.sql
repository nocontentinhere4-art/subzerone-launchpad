-- The estimate shown at review time (fees, rent, dev buy, simulation) is kept with the intent so that resuming a
-- prepared transaction (page reload) shows the same numbers instead of "cost unknown". 2026-10-11
ALTER TABLE launch_intents ADD COLUMN estimate_json TEXT;
