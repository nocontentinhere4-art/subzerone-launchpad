// Vote ledger (append-only, hash-chained, private ideas masked) and the public disclosure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { user, drain, IDEA, harness, makeEnv } from './helpers.js';
import { canonical, GENESIS, ideaHash } from '../src/trust.js';
import { sha256 } from '../src/util.js';
import { loadConfig } from '../src/config.js';

const HASHED = ['seq', 'at', 'ideaHash', 'requestHash', 'decision', 'networks', 'vote', 'mood', 'stage', 'gain'];
const PASS_IDEA = (w) => IDEA(w, { title: 'Sock Exchange', concept: 'A coin for swapping lost single socks between neighbours in Osaka, with a weekly sock lottery.',
  nameSuggestion: 'Sock Exchange', tickerSuggestion: 'SOCK' });

/** Two brain answers: a build (Ramen Radar) and a pass (Sock Exchange), both private. */
async function twoVotes() {
  const h = await harness();
  const owner = h.client(user(h.db));
  await owner.signIn();
  const a = (await owner.call('POST', '/api/ideas', IDEA(owner.w))).json.id;
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  h.brain.state.mode = 'pass';
  const b = (await owner.call('POST', '/api/ideas', PASS_IDEA(owner.w))).json.id;
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  return { h, owner, a, b };
}

test('vote ledger: one row per brain answer (build and pass, private included), chained from genesis', async () => {
  const { h, owner, a, b } = await twoVotes();
  try {
    const rows = h.db.all('SELECT * FROM vote_ledger ORDER BY seq');
    assert.deepEqual(rows.map((r) => [r.seq, r.decision, r.request_id]), [[1, 'build', `${a}.v1`], [2, 'pass', `${b}.v1`]]);
    assert.equal(rows[0].prev_hash, GENESIS);
    assert.equal(rows[1].prev_hash, rows[0].hash);
    assert.equal(rows[0].idea_hash, ideaHash(IDEA(owner.w).title, IDEA(owner.w).concept, 1));
    // a replayed evaluation (admin retry, duplicate delivery) appends nothing
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM vote_ledger').n, 2);
    // the owner's idea page links its row
    assert.deepEqual((await owner.call('GET', `/api/ideas/${a}`)).json.evaluation.ledger, { seq: 1, hash: rows[0].hash });

    const head = await owner.call('GET', '/api/votes/head');
    assert.deepEqual(head.json, { seq: 2, hash: rows[1].hash, at: rows[1].at });
    const v = await owner.call('GET', '/api/votes/verify');
    assert.deepEqual(v.json, { ok: true, broken_at: null, from: 1, to: 2, checked: 2 });
  } finally { h.close(); }
});

test('GET /api/votes: newest first, no titles, labels or wallets for private/declined ideas; recomputable from the output', async () => {
  const { h, owner, a, b } = await twoVotes();
  try {
    const anon = h.client(user(h.db));
    let r = await anon.call('GET', '/api/votes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.votes.map((x) => x.seq), [2, 1]);
    for (const leak of ['Ramen Radar', 'Sock Exchange', 'build: ', owner.w.address, a, b, 'leaned_to']) assert.ok(!r.text.includes(leak), `leaked ${leak}`);
    const [pass, build] = r.json.votes;
    assert.equal(pass.idea, null);
    assert.equal(build.decision, 'build');
    assert.deepEqual(build.networks, { attention: 0.5, language: 0.8, reward: 1 });
    assert.deepEqual(build.mood, { boredom: 0.2, pressure: 0.1, tired: 0 });
    assert.equal(build.gain, 1.1);
    assert.equal(build.stage, 'AWAKE');
    assert.deepEqual(build.vote.options.map((o) => [o.action, o.p, o.chosen]), [['build', 0.8, true], ['pass', 0.2, false]]);
    assert.deepEqual(build.vote.spiking, { used: false, net: 'rate', network: 'rate model only', pick: null });
    assert.equal(build.vote.demo, true);
    // anyone can recompute every hash from the public output alone
    let prev = GENESIS;
    for (const x of [...r.json.votes].reverse()) {
      assert.equal(x.prevHash, prev);
      assert.equal(sha256(x.prevHash + canonical(Object.fromEntries(HASHED.map((k) => [k, x[k]])))), x.hash);
      prev = x.hash;
    }
    assert.equal(build.requestHash, sha256(`${a}.v1`));

    // published (and still alive): title, slug, request id appear; a published PASSED idea stays anonymous
    assert.equal((await owner.call('POST', `/api/ideas/${a}/publish`, { public: true })).status, 200);
    assert.equal((await owner.call('POST', `/api/ideas/${b}/publish`, { public: true })).status, 200);
    r = await anon.call('GET', '/api/votes');
    const slug = h.db.get('SELECT slug FROM projects WHERE idea_id = ?', a).slug;
    assert.deepEqual(r.json.votes[1].idea, { ideaId: a, requestId: `${a}.v1`, title: 'Ramen Radar', slug });
    assert.equal(r.json.votes[0].idea, null);
    assert.ok(!r.text.includes('Sock Exchange') && !r.text.includes(b));
    assert.equal((await anon.call('GET', `/api/ideas/${b}`)).json.evaluation.ledger, null, 'a passed idea is not linked publicly');

    // paging and strict parameters
    r = await anon.call('GET', '/api/votes?limit=1');
    assert.deepEqual([r.json.votes.length, r.json.votes[0].seq, r.json.next], [1, 2, 2]);
    r = await anon.call('GET', '/api/votes?limit=1&before=2');
    assert.deepEqual([r.json.votes[0].seq, r.json.next], [1, 1]);
    r = await anon.call('GET', '/api/votes?before=1');
    assert.deepEqual([r.json.votes.length, r.json.next], [0, null]);
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'before=-1', 'before=1.5']) assert.equal((await anon.call('GET', `/api/votes?${q}`)).status, 400, q);
    for (const q of ['from=0', 'from=2&to=1', 'from=x']) assert.equal((await anon.call('GET', `/api/votes/verify?${q}`)).status, 400, q);
  } finally { h.close(); }
});

test('vote ledger: append-only in the database, and verify finds a tampered or missing row', async () => {
  const { h } = await twoVotes();
  try {
    const c = h.client(user(h.db));
    assert.throws(() => h.db.run(`UPDATE vote_ledger SET decision = 'pass' WHERE seq = 1`), /append-only/);
    assert.throws(() => h.db.run('DELETE FROM vote_ledger WHERE seq = 2'), /append-only/);
    // someone with database access goes around the triggers
    h.db.exec('DROP TRIGGER vote_ledger_no_update; DROP TRIGGER vote_ledger_no_delete;');
    h.db.run(`UPDATE vote_ledger SET vote_json = replace(vote_json, '0.8', '0.9') WHERE seq = 2`);
    assert.deepEqual((await c.call('GET', '/api/votes/verify')).json, { ok: false, broken_at: 2, from: 1, to: 2, checked: 2 });
    assert.equal((await c.call('GET', '/api/votes/verify?from=1&to=1')).json.ok, true);
    h.db.run(`UPDATE vote_ledger SET decision = 'pass' WHERE seq = 1`);
    assert.equal((await c.call('GET', '/api/votes/verify')).json.broken_at, 1);
    // re-hashing a forged row does not help: the next row's prev_hash no longer matches
    const r1 = h.db.get('SELECT * FROM vote_ledger WHERE seq = 1');
    h.db.run('UPDATE vote_ledger SET hash = ? WHERE seq = 1', sha256(r1.prev_hash + canonical({ seq: 1, at: r1.at, ideaHash: r1.idea_hash,
      requestHash: sha256(r1.request_id), decision: 'pass', networks: JSON.parse(r1.networks_json), vote: JSON.parse(r1.vote_json),
      mood: JSON.parse(r1.mood_json), stage: r1.stage, gain: r1.gain })));
    assert.equal((await c.call('GET', '/api/votes/verify?from=1&to=1')).json.ok, true);
    assert.equal((await c.call('GET', '/api/votes/verify')).json.broken_at, 2);
    // a deleted row is a gap
    h.db.run('DELETE FROM vote_ledger WHERE seq = 1');
    assert.equal((await c.call('GET', '/api/votes/verify')).json.broken_at, 1);
  } finally { h.close(); }
});

test('vote ledger: empty head is genesis; a rule decline (never asked the brain) adds no row', async () => {
  const h = await harness();
  try {
    const c = h.client(user(h.db));
    assert.deepEqual((await c.call('GET', '/api/votes/head')).json, { seq: 0, hash: GENESIS, at: null });
    assert.deepEqual((await c.call('GET', '/api/votes/verify')).json, { ok: true, broken_at: null, from: 1, to: 0, checked: 0 });
    await c.signIn();
    await c.call('POST', '/api/ideas', IDEA(c.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const dup = (await c.call('POST', '/api/ideas', IDEA(c.w))).json.id;      // a copy of the first: declined by policy
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(h.db.get('SELECT decided_by FROM evaluations WHERE idea_id = ?', dup).decided_by, 'policy:duplicate');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM vote_ledger').n, 1);
  } finally { h.close(); }
});

test('GET /api/disclosure: fixed JSON, cacheable, datasets and operator from the environment', async () => {
  const h = await harness({ SUB01_DATASETS: 'HCP Young Adult 1200, Natural Scenes Dataset', OPERATOR_NAME: 'SUBZERONE operator' });
  try {
    const r = await h.client(user(h.db)).call('GET', '/api/disclosure');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /public, max-age=3600/);
    assert.deepEqual(r.json, { system: 'SUB-01', nature: 'AI dev driven by a model of real human brain activity, built from MRI recordings of real brains',
      datasets: ['HCP Young Adult 1200', 'Natural Scenes Dataset'], decision: 'brain vote; reproducible from the ledger',
      human_gate: 'every publication and every transaction is approved/signed by a human', operator: 'SUBZERONE operator',
      x_automation_label: true,
      chat_replies: 'SUB-01\'s chat replies in the city are generated by the SUB-01 live server: written by a language model, or a fixed answer for questions about being human, money or instructions', ai_act: 'Art. 50 disclosure',
      coin_stats: r.json.coin_stats, updated_at: '2026-10-10' });
    // the building-lights line names its sources and the thresholds the city shows (coin-stats.js THRESHOLDS)
    assert.match(r.json.coin_stats.text, /real market and on-chain data only/);
    assert.ok(r.json.coin_stats.sources.some((s) => /dexscreener/i.test(s)) && r.json.coin_stats.sources.some((s) => /helius/i.test(s)));
    assert.deepEqual(r.json.coin_stats.thresholds, { lit: { holders: 1000, volume24hUsd: 25000 }, roof: { holders: 10000, marketCapUsd: 1000000 }, sign: { holders: 100000, marketCapUsd: 10000000 } });
    assert.deepEqual(r.json.coin_stats.tiers, ['none', 'open', 'lit', 'roof', 'sign']);
  } finally { h.close(); }
  const { cfg } = makeEnv();
  assert.deepEqual(cfg.trust, { datasets: [], operatorName: null });
  assert.throws(() => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', SUB01_DATASETS: 'ok, <script>' }), /SUB01_DATASETS/);
  assert.throws(() => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', OPERATOR_NAME: 'x'.repeat(81) }), /OPERATOR_NAME/);
});
