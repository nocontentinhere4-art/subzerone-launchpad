// End-to-end demonstration against a RUNNING launchpad (npm run dev) and SUB-01 brain (scripts/brain-demo.sh):
// test wallet signs in -> submits an idea -> the brain votes -> preview -> publish + approve -> reviewer clears ->
// launch configuration -> transaction signed by the test wallet -> confirmation -> verification -> fee ledger.
// Development only: test wallets live in data/devnet/ and the demo reviewer is promoted directly in the local DB.
// With LAUNCH_PROVIDER=mock the "transaction" is the clearly labelled mock; with pumpfun on devnet it is a real devnet
// transaction (the test wallet needs devnet SOL). Never run against production.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { loadConfig, ROOT } from '../src/config.js';
import { openDb } from '../src/db.js';
import { b58encode } from '../src/util.js';
import { mockSigningText } from '../src/launch/mock.js';
import { eventAuthorities } from '../src/launch/pumpfun.js';
import { devnetKeypair } from './devnet-wallet.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const cfg = loadConfig();
if (cfg.production) throw new Error('demo-flow refuses to run with DEPLOY_ENV=production');
const BASE = process.env.LAUNCHPAD_URL || `http://127.0.0.1:${cfg.port}`;
const log = [];
const step = (msg, data) => { const row = { t: new Date().toISOString(), msg, ...(data ? { data } : {}) }; log.push(row); console.log(`• ${msg}`, data ? JSON.stringify(data).slice(0, 400) : ''); };

function client(kp) {
  let cookie = '';
  const address = kp.publicKey.toBase58();
  const signText = (text) => b58encode(web3.Keypair.fromSecretKey(kp.secretKey) && signDetached(Buffer.from(text, 'utf8'), kp));
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, { method, headers: { origin: cfg.publicOrigin, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.message || json?.error || ''}`);
    return json;
  };
  return { address, call, signText,
    async signIn() { const n = await call('POST', '/api/auth/nonce', { wallet: address }); await call('POST', '/api/auth/verify', { wallet: address, nonce: n.nonce, signature: signText(n.message) }); } };
}

function signDetached(msg, kp) {
  // ed25519 over the message with the keypair's 32-byte seed
  const { createPrivateKey } = require('node:crypto');
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return sign(null, msg, createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

/** Phantom-safe: the event authorities are written into the message (static keys), never loaded from a lookup table
 *  (tx2 has no table at all; it does not touch the pump-fees program's event authority). */
function layoutOf(txBase64) {
  const m = web3.VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64')).message, statics = m.staticAccountKeys.map(String);
  const [pump, pumpFees] = eventAuthorities().map(String);
  return { bytes: Buffer.from(txBase64, 'base64').length, lookupTables: m.addressTableLookups.length, signers: m.header.numRequiredSignatures,
    instructions: m.compiledInstructions.length, pumpEventAuthorityStatic: statics.includes(pump), pumpFeesEventAuthorityStatic: statics.includes(pumpFees) };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await wait(1500);
  }
}

const submitter = client(devnetKeypair(process.env.DEMO_WALLET || 'demo-submitter'));
const reviewer = client(devnetKeypair('demo-reviewer'));
step('launchpad', { base: BASE, provider: cfg.launch.provider, network: cfg.launch.network, brain: cfg.brain.url });

await submitter.signIn();
await reviewer.signIn();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
db.run("UPDATE users SET role = 'reviewer' WHERE wallet = ?", reviewer.address);          // local demo only
step('signed in (signed messages, no transactions)', { submitter: submitter.address, reviewer: `${reviewer.address} (promoted to reviewer in the local DB)` });

const title = process.env.DEMO_TITLE || `Night Ramen Map ${new Date().toISOString().slice(11, 16)}`;
const { id } = await submitter.call('POST', '/api/ideas', {
  title, concept: process.env.DEMO_CONCEPT || 'A tiny community map of the best late-night ramen counters in Tokyo, drawn by hand, one bowl at a time. Sweet, warm, a little nostalgic.',
  tickerSuggestion: process.env.DEMO_TICKER || 'RAMEN', links: ['https://en.wikipedia.org/wiki/Ramen'], contacts: { x: 'ramen_fan' },
  // DEMO_RECEIVING_WALLET: another wallet receives the author's fee share (e.g. a launchpad parent whose author is not the visitor)
  receivingWallet: process.env.DEMO_RECEIVING_WALLET || submitter.address, rightsConfirmed: true,
});
step('idea submitted (private)', { id });

const evaluated = await until(async () => { const x = await submitter.call('GET', `/api/ideas/${id}`); return x.evaluation ? x : null; }, 'the brain vote', 30 * 60_000);
const vote = evaluated.evaluation.brain?.vote;
const byRule = evaluated.evaluation.decidedBy.startsWith('policy:');
step(byRule ? `declined by rule before reaching SUB-01 (${evaluated.evaluation.decidedBy})` : `SUB-01's brain vote: ${evaluated.evaluation.decision === 'selected' ? 'build' : 'pass'}`, {
  options: vote?.options?.map((o) => ({ label: o.label, p: o.p, value: o.value, response: o.response })), reason: vote?.reason,
  network: vote?.spiking?.network, networks: evaluated.evaluation.brain?.networks, demoBrain: evaluated.evaluation.brain?.demo, scores: evaluated.evaluation.scores });
if (evaluated.evaluation.decision !== 'selected') {
  step(byRule ? 'the flow stops here (rule decision)' : 'he passed; the flow stops here (re-run for another vote)');
  writeTranscript();
  process.exit(0);
}

const preview = await until(async () => { const x = await submitter.call('GET', `/api/ideas/${id}`); return x.status === 'preview_ready' ? x : null; }, 'the build');
const slug = preview.project.slug;
let p = await submitter.call('GET', `/api/projects/${slug}`);
step('built: preview ready', { slug, name: p.name, ticker: p.ticker, generator: p.generator, siteVersion: p.liveSiteVersion, xPlanned: p.x?.planned_handle, xStatus: p.x?.status, split: p.allocation?.recipients });

// DEMO_INITIAL_BUY_SOL: the author's dev buy (PUT …/launch/options), e.g. 0.01 on devnet
if (process.env.DEMO_INITIAL_BUY_SOL) {
  const opt = await submitter.call('PUT', `/api/projects/${slug}/launch/options`, { initialBuySol: Number(process.env.DEMO_INITIAL_BUY_SOL) });
  step('dev buy set by the author', opt);
}

await submitter.call('POST', `/api/ideas/${id}/publish`, { public: true });
await submitter.call('POST', `/api/projects/${slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion });
step('submitter published the idea and approved site + fee split', { statement: p.allocation.statement });
const needClear = (await submitter.call('GET', '/api/config')).requireAdminClearance !== false;   // production runs without the reviewer step
if (needClear) await reviewer.call('POST', `/api/admin/projects/${slug}/clear`, {});
step('reviewer cleared it for launch');

p = await until(async () => { const x = await submitter.call('GET', `/api/projects/${slug}`); return x.status === 'launch_prepared' ? x : null; }, 'the launch configuration');
const c = p.launchConfig;
step('launch configuration ready for review', { provider: c.providerLabel, network: c.network, name: c.token.name, symbol: c.token.symbol, uri: c.token.uri,
  supply: c.token.totalSupplyBase, decimals: c.token.decimals, initialBuyLamports: c.initialBuyLamports, recipients: c.feeSharing.recipients, irreversible: c.irreversible, tradingFees: c.tradingFees });

const tx = await submitter.call('POST', `/api/projects/${slug}/launch/transaction`, {});
step('transaction built (launch intent persisted before signing)', { mint: tx.mint, mock: tx.mock, estimate: tx.estimate, bytes: tx.txBytes, ...(tx.mock ? {} : { layout: layoutOf(tx.txBase64) }) });
let signed;
if (tx.mock) {
  signed = submitter.signText(mockSigningText(tx.messageHash));
} else {
  const kp = devnetKeypair(process.env.DEMO_WALLET || 'demo-submitter');
  // the city refreshes the blockhash right before the wallet opens (same mint, same instructions)
  const fresh = await submitter.call('POST', `/api/projects/${slug}/launch/refresh`, {});
  step('refreshed right before signing', { refreshed: fresh.refreshed === true, sameMint: fresh.mint === tx.mint, bytes: fresh.txBytes });
  const vt = web3.VersionedTransaction.deserialize(Buffer.from(fresh.txBase64, 'base64'));
  vt.sign([kp]);
  signed = Buffer.from(vt.serialize()).toString('base64');
}
const sub = await submitter.call('POST', `/api/projects/${slug}/launch/signed`, { signed });
step('signed by the test wallet and submitted', sub);

p = await until(async () => { const x = await submitter.call('GET', `/api/projects/${slug}`); return ['launched', 'launch_prepared', 'failed'].includes(x.status) ? x : null; }, 'confirmation', 240_000);
step(`result: ${p.status}`, { note: p.statusNote, launch: p.launch && { mint: p.launch.mint, tx: p.launch.tx_signature, network: p.launch.network, provider: p.launch.provider,
  checks: p.launch.verification, explorer: p.launch.explorerTx } });
// step 2: the dev buy as its own transaction, signed by the author alone (DEMO_SKIP_DEV_BUY=1 skips it instead)
if (p.status === 'launched' && p.devBuy?.status === 'pending') {
  if (process.env.DEMO_SKIP_DEV_BUY === '1') {
    step('dev buy skipped', await submitter.call('POST', `/api/projects/${slug}/launch/devbuy/skip`, {}));
  } else {
    const b = await submitter.call('POST', `/api/projects/${slug}/launch/devbuy/transaction`, {});
    step('step 2: dev buy transaction built (quoted on the live curve)', { attempt: b.attemptId, mock: b.mock, estimate: b.estimate, bytes: b.txBytes,
      programs: b.programs?.map((x) => `${x.name}${x.direct ? '' : ' (inside)'}`), signers: b.signers, ...(b.mock ? {} : { layout: layoutOf(b.txBase64) }) });
    let signedBuy;
    if (b.mock) signedBuy = submitter.signText(mockSigningText(b.messageHash));
    else {
      const fresh = await submitter.call('POST', `/api/projects/${slug}/launch/devbuy/refresh`, {});
      step('step 2: refreshed right before signing (same tokens, same cap)', { refreshed: fresh.refreshed === true, sameTokens: fresh.tokensBase === b.tokensBase, bytes: fresh.txBytes });
      const vt = web3.VersionedTransaction.deserialize(Buffer.from(fresh.txBase64, 'base64'));
      vt.sign([devnetKeypair(process.env.DEMO_WALLET || 'demo-submitter')]);
      signedBuy = Buffer.from(vt.serialize()).toString('base64');
    }
    step('step 2: signed by the test wallet alone and submitted', await submitter.call('POST', `/api/projects/${slug}/launch/devbuy/signed`, { signed: signedBuy }));
    p = await until(async () => { const x = await submitter.call('GET', `/api/projects/${slug}`); return ['done', 'failed', 'pending'].includes(x.devBuy?.status) ? x : null; }, 'the dev buy', 240_000);
    step(`step 2 result: ${p.devBuy.status}`, { note: p.statusNote, attempt: p.devBuy.attempt });
  }
}
const ledger = await submitter.call('GET', '/api/ledger');
step('public fee ledger entry', ledger.projects.find((x) => x.slug === slug)?.ledger);
writeTranscript();

function writeTranscript() {
  const dir = join(ROOT, 'docs', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `flow-${cfg.launch.provider}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(log, null, 2));
  console.log(`\ntranscript: ${file}`);
}
