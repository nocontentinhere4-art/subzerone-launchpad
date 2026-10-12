-- Launchpad families (src/family.js, docs/APP-COMPOSER.md "Launchpad families"), 2026-10-12. A coin launched from a
-- launchpad's site can itself be a launchpad (the parent's launch block says `children`: coins / launchpads / choice),
-- down to family.js MAX_DEPTH. Its creator fees flow up the family tree, split on-chain and locked at launch: the
-- creator, the parent launchpad's author, the grandparent's author (from depth 2), SUB-01.
-- What the visitor signed is kept as it was signed: whether the coin is a launchpad, its depth in the family, and the
-- parent's launch-block split the server computed the shares from (the strict re-check at prepare and at signing
-- recomputes the exact rows from these and the recorded author wallets).
ALTER TABLE child_launches ADD COLUMN as_launchpad INTEGER NOT NULL DEFAULT 0;
ALTER TABLE child_launches ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE child_launches ADD COLUMN split_json TEXT;          -- {creator, parent, sub01} bps of the parent's block; NULL before 020
