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
