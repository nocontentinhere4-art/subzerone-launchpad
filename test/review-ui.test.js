// The owner's review-before-sign box (public/js/review.js), rendered in Node: everything the wallet will show is listed
// before the Sign button, and the button is disabled when the payer is not the viewer or a non-launch program appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { addEventListener() {} };          // lib.js wires one click listener at import
const { txReview } = await import('../public/js/review.js');

const ME = 'So1anaOwnerWa11etAddressxxxxxxxxxxxxxxxxxx1';
const SUB01 = 'Sub01FeeWa11etAddressxxxxxxxxxxxxxxxxxxxxx2';
const CONFIG = { feeSharing: { locked: true, recipients: [{ label: 'Idea submitter', wallet: ME, bps: 8000 }, { label: 'SUB-01', wallet: SUB01, bps: 2000 }] } };
const TX = { mock: false, network: 'devnet', feePayer: ME, mint: 'NewMintAddressxxxxxxxxxxxxxxxxxxxxxxxxxxx3', txBytes: 860, lastValidBlockHeight: 123,
  estimate: { networkFeeLamports: 10_000, accountsLamports: 20_000_000, simulation: { ok: true } }, signers: 2, accountsWritable: 9, launchProgramsOnly: true,
  programs: [{ id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', name: 'pump.fun (bonding curve)', direct: true },
    { id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', name: 'Token-2022', direct: false }] };

test('review box: network, payer, mint, programs, writable accounts, cost, split and what it does NOT do, before Sign', () => {
  const s = txReview(TX, CONFIG, ME, 'Phantom').s;
  const sign = s.indexOf('id="sign"');
  for (const want of ['<b>devnet</b>', `${ME} <b>(you)</b>`, TX.mint, 'pump.fun (bonding curve)', 'Token-2022', '(called inside the one above)',
    'accounts it can write</span><span>9', '0.02001 SOL', '8000 (80%)', '2000 (20%)', SUB01, 'locked at launch', 'What this does NOT do']) {
    const at = s.indexOf(want);
    assert.ok(at > 0 && at < sign, `missing before Sign: ${want}`);
  }
  assert.match(s, /id="sign" >Sign with Phantom/);
});

test('review box: Sign disabled for a foreign payer or a non-launch program; mock says nothing leaves the wallet', () => {
  assert.match(txReview({ ...TX, feePayer: SUB01 }, CONFIG, ME).s, /not your wallet: don't sign[\s\S]*id="sign" disabled/);
  const odd = txReview({ ...TX, launchProgramsOnly: false, programs: [{ id: '11111111111111111111111111111111', name: 'System Program', direct: true }] }, CONFIG, ME).s;
  assert.match(odd, /not part of a launch[\s\S]*id="sign" disabled/);
  assert.ok(!odd.includes('What this does NOT do'));
  const mock = txReview({ ...TX, mock: true, network: 'mock', signers: 1, accountsWritable: 0, estimate: { networkFeeLamports: 0, accountsLamports: 0 },
    programs: [{ id: 'MockLaunch', name: 'MockLaunch', direct: true }] }, CONFIG, ME).s;
  assert.match(mock, /Nothing leaves your wallet/);
  assert.match(mock, /MockLaunch/);
  // escaped: a hostile label cannot inject markup
  assert.ok(!txReview(TX, { feeSharing: { ...CONFIG.feeSharing, recipients: [{ label: '<img src=x>', wallet: ME, bps: 10000 }] } }, ME).s.includes('<img'));
});
