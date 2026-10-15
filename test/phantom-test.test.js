// The admin Phantom diagnostic (src/phantom-test.js): admin-only, offline builds on a fixture chain, the throwaway
// mint's signature slot always empty, and no path that sends anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { harness, wallet } from './helpers.js';
import { createPhantomTest, VARIANTS, phantomTestPage } from '../src/phantom-test.js';
import { launchInstructions } from '../src/launch/pumpfun.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

/** A connection with a fresh blockhash and a lookup table holding every account common to two launches. */
function fixtureConn() {
  let table = null, calls = 0;
  return {
    get calls() { return calls; },
    async getLatestBlockhash() { calls++; return { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }; },
    async getAddressLookupTable() {
      calls++;
      if (!table) {
        const keys = async () => {
          const s = web3.Keypair.generate().publicKey;
          const config = { name: 'x', symbol: 'X', uri: 'https://x', initialBuyLamports: 0, feeSharing: { mode: 'sharing_config',
            shareholders: [{ wallet: s.toBase58(), bps: 8000 }, { wallet: web3.Keypair.generate().publicKey.toBase58(), bps: 2000 }] } };
          const { ixs } = await launchInstructions({ config, mint: web3.Keypair.generate().publicKey, signer: s });
          return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
        };
        const [a, b] = [await keys(), await keys()];
        table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...a].filter((k) => b.has(k)).map((k) => new web3.PublicKey(k)) } });
      }
      return { value: table };
    },
  };
}
const CFG = (over = {}) => ({ publicOrigin: 'https://city.subzerone.live', sub01FeeWallet: web3.Keypair.generate().publicKey.toBase58(),
  launch: { rpcUrl: 'http://127.0.0.1:1', network: 'mainnet-beta', lookupTable: '', eventAuthStatic: false, ...over } });

test('phantom test: every variant builds offline, unsigned, with the throwaway mint slot empty; sizes reported', async () => {
  const admin = web3.Keypair.generate().publicKey.toBase58();
  const pt = createPhantomTest(CFG(), { connection: fixtureConn() });
  const sizes = {};
  for (const v of Object.keys(VARIANTS)) {
    const out = await pt.build({ variant: v, wallet: admin });
    assert.equal(out.variant, v);
    assert.ok(out.description);
    if (out.skipped) { sizes[v] = `skipped: ${out.reason}`; continue; }
    sizes[v] = out.bytes;
    assert.ok(out.bytes > 100 && out.bytes <= 1232, `${v}: ${out.bytes} bytes`);
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(out.txBase64, 'base64'));
    assert.equal(tx.serialize().length, out.bytes);
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), admin, 'the admin pays');
    assert.ok(tx.signatures.every((s) => s.every((b) => b === 0)), 'nothing signed');
    if (out.mint) {
      const keys = tx.message.staticAccountKeys.map(String);
      assert.equal(tx.message.header.numRequiredSignatures, 2);
      assert.equal(keys[1], out.mint, 'the throwaway mint is the second signer');
      assert.ok(tx.signatures[1].every((b) => b === 0), 'the mint signature slot is empty');
      assert.equal(out.mintSignatureEmpty, true);
    } else assert.equal(tx.message.header.numRequiredSignatures, 1);
    assert.equal(out.chain, 'solana:mainnet');
  }
  assert.equal(typeof sizes.A, 'number'); assert.equal(typeof sizes.C, 'number'); assert.equal(typeof sizes.E, 'number');
  assert.ok(sizes.A < sizes.C, 'create only is smaller than the full launch');
  const c = await pt.build({ variant: 'C', wallet: admin });
  assert.equal(web3.VersionedTransaction.deserialize(Buffer.from(c.txBase64, 'base64')).message.compiledInstructions.length, 3);
  assert.equal(c.lookupTable, true, 'C uses the lookup table');
  console.log('phantom test sizes (fixture table):', JSON.stringify(sizes));
  // two builds never share a mint
  const [x, y] = [await pt.build({ variant: 'A', wallet: admin }), await pt.build({ variant: 'A', wallet: admin })];
  assert.notEqual(x.mint, y.mint);
  await assert.rejects(pt.build({ variant: 'Z', wallet: admin }), /unknown variant/);
});

test('phantom test: the module has no send path and keeps no mint secret; the page never sends or posts signed bytes', () => {
  const src = readFileSync(new URL('../src/phantom-test.js', import.meta.url), 'utf8');
  for (const bad of [/sendTransaction/, /sendRawTransaction/, /signAndSend/, /simulateTransaction/, /secretKey/, /\.submit\(/, /db\.(run|get|all)/]) assert.doesNotMatch(src, bad);
  const page = phantomTestPage({ nonce: 'n', state: 'admin', wallet: 'W' });
  assert.doesNotMatch(page, /signAndSend|sendTransaction|sendRawTransaction/);
  assert.match(page, /signTransaction/);
  // the only POSTs the page makes: sign-in and the variant request ({variant, wallet})
  assert.deepEqual([...new Set([...page.matchAll(/api\('([^']+)'/g)].map((m) => m[1]))].sort(), ['/api/admin/phantom-test/tx', '/api/auth/nonce', '/api/auth/verify']);
});

test('phantom test routes: admin wallets from ADMIN_WALLETS only; a 403 page for others; wallet must match the session', async () => {
  const admin = wallet(), user = wallet();
  const conn = fixtureConn();
  const h = await harness({ ADMIN_WALLETS: admin.address, LAUNCH_LOOKUP_TABLE: web3.Keypair.generate().publicKey.toBase58() }, { phantomTest: { connection: conn } });
  try {
    const anon = h.client(user);
    const page = await anon.call('GET', '/admin/phantom-test');
    assert.equal(page.status, 200);
    assert.match(page.text, /Sign in/);
    assert.doesNotMatch(page.text, /data-v="A"/, 'no tool before sign-in');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-/); assert.match(csp, /connect-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
    assert.equal((await anon.call('POST', '/api/admin/phantom-test/tx', { variant: 'A', wallet: user.address })).status, 401);
    await anon.signIn();
    assert.equal((await anon.call('GET', '/admin/phantom-test')).status, 403);
    assert.equal((await anon.call('POST', '/api/admin/phantom-test/tx', { variant: 'A', wallet: user.address })).status, 403);
    // a DB-promoted admin who is not in ADMIN_WALLETS is refused too
    h.db.run("UPDATE users SET role = 'admin' WHERE wallet = ?", user.address);
    assert.equal((await anon.call('POST', '/api/admin/phantom-test/tx', { variant: 'A', wallet: user.address })).status, 403);
    assert.equal(conn.calls, 0, 'nothing built for a non-admin');

    const a = h.client(admin);
    await a.signIn();
    const tool = await a.call('GET', '/admin/phantom-test');
    assert.equal(tool.status, 200);
    for (const v of Object.keys(VARIANTS)) assert.match(tool.text, new RegExp(`data-v="${v}"`));
    const nonce = /script-src 'nonce-([^']+)'/.exec(tool.headers.get('content-security-policy'))[1];
    assert.ok(tool.text.includes(`<script nonce="${nonce}">`));
    assert.equal((await a.call('POST', '/api/admin/phantom-test/tx', { variant: 'A', wallet: user.address })).status, 403, 'wallet must be the session wallet');
    assert.equal((await a.call('POST', '/api/admin/phantom-test/tx', { variant: 'Q', wallet: admin.address })).status, 400);
    const ok = await a.call('POST', '/api/admin/phantom-test/tx', { variant: 'C', wallet: admin.address });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.txBase64, ok.text);
    assert.equal(ok.json.variant, 'C');
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(ok.json.txBase64, 'base64'));
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), admin.address);
    assert.ok(tx.signatures[1].every((b) => b === 0));
    assert.equal(ok.json.bytes, tx.serialize().length);
    // nothing stored: no launch intent, no project
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launch_intents').n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM projects').n, 0);
    // cross-site POST refused like every other write
    assert.equal((await a.call('POST', '/api/admin/phantom-test/tx', { variant: 'A', wallet: admin.address }, { origin: 'https://evil.example' })).status, 403);
  } finally { h.close(); }
});
