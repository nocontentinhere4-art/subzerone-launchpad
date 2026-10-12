-- The holder tools of the coin sites (onchain.js, holder-tools.js, docs/SITE-KIT.md "Holder tools"), 2026-10-12.
-- Read-only copies of public chain data, fetched incrementally while a site page asks for them. Nothing here is
-- private and nothing is estimated: every row is one decoded transaction or event.

-- One row per watched address (the bonding curve, the author's token account, the fee sharing config): where the
-- signature listing stands. newest_sig: the next poll asks only for what came after it; oldest_sig: the backfill of
-- older history continues before it; listed_all: the listing reached the address's first transaction.
CREATE TABLE chain_cursors (
  address     TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('curve','dev','fees')),
  newest_sig  TEXT,
  oldest_sig  TEXT,
  listed_all  INTEGER NOT NULL DEFAULT 0,
  polled_at   INTEGER,
  error       TEXT
);

-- The work queue and its results: every signature listed for a watched address. failed: the transaction failed on
-- chain (nothing to decode, never fetched). done_at: fetched and decoded. data_json: per-transaction facts for this
-- address (the author's token change; a fee distribution).
CREATE TABLE chain_sigs (
  address     TEXT NOT NULL,
  signature   TEXT NOT NULL,
  mint        TEXT NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  failed      INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER,
  data_json   TEXT,
  PRIMARY KEY (address, signature)
);
CREATE INDEX chain_sigs_todo ON chain_sigs(address, done_at, slot);

-- Decoded pump.fun bonding-curve TradeEvents (one per trade; a transaction can hold several).
CREATE TABLE chain_trades (
  signature     TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  mint          TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  block_time    INTEGER,
  is_buy        INTEGER NOT NULL,
  quote_amount  INTEGER NOT NULL,             -- lamports (SOL curves) or the quote mint's base units
  token_amount  INTEGER NOT NULL,             -- the coin's base units (6 decimals)
  user          TEXT NOT NULL,
  fee           INTEGER NOT NULL,             -- protocol fee, quote base units
  creator_fee   INTEGER NOT NULL,             -- creator fee of this trade, quote base units
  quote_mint    TEXT,
  ix_name       TEXT,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX chain_trades_mint ON chain_trades(mint, slot);
CREATE INDEX chain_trades_user ON chain_trades(mint, user, slot);
