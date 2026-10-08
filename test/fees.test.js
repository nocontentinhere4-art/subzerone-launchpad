// Fee reconciliation against a provider whose chain view changes over time (indexing delay, later distributions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, user } from './helpers.js';
import { reconcileFees, feeLedger, setProviderForTests } from '../src/launch.js';

function launched(db, mode, recipients) {
  const owner = user(db);
  const t = Date.now();
  db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES ('idea_f', ?, 'launched', 'public', ?, ?)`, owner.address, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES ('prj_f', 'idea_f', 'f', 'F', 'F', 'd', ?, ?)`, t, t);
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES ('al_f', 'prj_f', 1, ?, 10000, 'locked', ?)`, JSON.stringify(recipients), t);
  const config = { feeSharing: { mode, shareholders: recipients.map(({ wallet, bps }) => ({ wallet, bps })), recipients, locked: mode === 'sharing_config' }, tradingFees: {} };
  db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
          VALUES ('in_f', 'prj_f', 'fake', 'devnet', ?, 'h', 'al_f', 'MintF', ?, 'confirmed', ?, ?)`, JSON.stringify(config), owner.address, t, t);
  db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES ('prj_f', 'in_f', 'fake', 'devnet', 'MintF', 'sigF', '[]', ?)`, t);
}

test('fees: indexing delay, then payouts; repeated reads never double count', async () => {
  const { cfg, db } = makeEnv();
  const a = user(db).address, b = user(db).address;
  launched(db, 'sharing_config', [{ label: 'Idea submitter', wallet: a, bps: 8000, role: 'submitter' }, { label: 'artist', wallet: b, bps: 2000, role: 'collaborator' }]);
  let chain = [];
  setProviderForTests(db, { name: 'fake', isMock: false, readFees: async () => chain }, cfg);

  await reconcileFees(db, cfg, 'prj_f');                          // nothing indexed yet
  let l = feeLedger(db, 'prj_f');
  assert.equal(l.verifiedUndistributedLamports, null, 'unknown, not zero, before the first observation');
  assert.equal(l.confirmedPayoutsLamports, 0);

  chain = [{ kind: 'vault_balance', account: 'Vault', lamports: 1_000_000, slot: 10 }];
  await reconcileFees(db, cfg, 'prj_f');
  l = feeLedger(db, 'prj_f');
  assert.equal(l.verifiedUndistributedLamports, 1_000_000);
  assert.equal(l.recipients[0].estimatedShareOfUndistributed, 800_000);

  await new Promise((r) => setTimeout(r, 5));
  chain = [{ kind: 'vault_balance', account: 'Vault', lamports: 0, slot: 20 },
    { kind: 'distribution', recipient: a, lamports: 800_000, txSignature: 'dist1', slot: 19, blockTime: 1 },
    { kind: 'distribution', recipient: b, lamports: 200_000, txSignature: 'dist1', slot: 19, blockTime: 1 }];
  await reconcileFees(db, cfg, 'prj_f');
  await reconcileFees(db, cfg, 'prj_f');                          // same transactions read again
  l = feeLedger(db, 'prj_f');
  assert.equal(l.confirmedPayoutsLamports, 1_000_000);
  assert.equal(l.verifiedUndistributedLamports, 0);
  assert.equal(l.verifiedAccruedLamports, 1_000_000);
  assert.equal(l.recipients.find((r) => r.wallet === b).confirmedPayouts, 200_000);
  assert.equal(db.get(`SELECT COUNT(*) n FROM fee_observations WHERE kind = 'distribution'`).n, 2);
});

test('fees: direct mode does not attribute a whole creator vault to one project', async () => {
  const { cfg, db } = makeEnv();
  const a = user(db).address;
  launched(db, 'direct', [{ label: 'Idea submitter', wallet: a, bps: 10000, role: 'submitter' }]);
  setProviderForTests(db, { name: 'fake', isMock: false, readFees: async () => [{ kind: 'vault_balance', account: 'V', lamports: 5, slot: 1 }] }, cfg);
  await reconcileFees(db, cfg, 'prj_f');
  const l = feeLedger(db, 'prj_f');
  assert.match(l.vaultScope, /all coins/);
  assert.equal(l.recipients[0].estimatedShareOfUndistributed, null);
});
