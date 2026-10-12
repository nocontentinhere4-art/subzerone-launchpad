// The impersonation pre-gate flags named endorsers, never technology (2026-10-12: "backed by post-quantum signatures" was refused).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyCheck } from '../src/scorecard.js';
const rule = (concept) => policyCheck({ title: 'Q-wave', concept })?.rule ?? null;
test('endorsement gate: technology passes, named endorsers and official claims are refused', () => {
  for (const ok of ['A launchpad backed by post-quantum signatures (ML-DSA-65).', 'Every launch backed by cryptography.', 'Backed by NIST-standard lattice signatures.',
    'supported by the community', 'endorsed by nobody', 'backed by real on-chain data']) assert.equal(rule(ok), null, ok);
  for (const bad of ['Backed by Binance.', 'Official token of Solana.', 'Partnered with @phantom.', 'Sponsored by Coinbase', 'in partnership with Jupiter'])
    assert.equal(rule(bad), 'impersonation', bad);
  assert.match(policyCheck({ title: 'x', concept: 'Backed by Binance and friends' }).why, /"Backed by Binance"/, 'the refusal quotes the phrase');
});

import { openDb, migrate } from '../src/db.js';
import { recoverConfigFailedBuilds } from '../src/pipeline.js';
test('builds that died on a model HTTP 400 are retried once at boot, other failures are not', () => {
  const db = openDb(':memory:'); migrate(db);
  const t = Date.now();
  db.run(`INSERT INTO users (wallet, created_at) VALUES ('w', ?)`, t);
  const idea = (id) => db.run(`INSERT INTO ideas (id, owner_wallet, status, status_note, created_at, updated_at) VALUES (?, 'w', 'failed', 'x', ?, ?)`, id, t, t);
  const job = (id, ideaId, err) => db.run(`INSERT INTO jobs (id, type, idempotency_key, idea_id, status, attempts, max_attempts, timeout_ms, run_after, last_error, created_at, updated_at)
    VALUES (?, 'generate', ?, ?, 'dead', 3, 3, 1000, ?, ?, ?, ?)`, id, id, ideaId, t, err, t, t);
  idea('i1'); job('j1', 'i1', 'generator HTTP 400'); idea('i2'); job('j2', 'i2', 'site rejected: x');
  assert.equal(recoverConfigFailedBuilds(db, t + 1000), 1);
  assert.equal(db.get(`SELECT status FROM ideas WHERE id = 'i1'`).status, 'selected');
  assert.equal(db.get(`SELECT status FROM jobs WHERE id = 'j1'`).status, 'queued');
  assert.equal(db.get(`SELECT status FROM ideas WHERE id = 'i2'`).status, 'failed');
  assert.equal(recoverConfigFailedBuilds(db, t + 2000), 0, 'not twice');
});
