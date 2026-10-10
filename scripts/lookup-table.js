// One-time operator setup: create the address lookup table that holds the static pump.fun accounts, so a launch with a
// locked multi-recipient fee split (and the optional dev buy) fits in ONE transaction (1232-byte limit). Prints
// LAUNCH_LOOKUP_TABLE.
//   node scripts/lookup-table.js                      devnet, pays with the throwaway test wallet in data/devnet/
//   node scripts/lookup-table.js --keypair <file>     any network (SOLANA_RPC_URL); the operator's own keypair file,
//                                                    read locally and never stored or sent anywhere by the app
//   node scripts/lookup-table.js --extend <table>     add the accounts a table made before the dev buy lacks (the
//                                                    signer must be the table's authority); nothing is sent if none
// Cost: rent for a ~600-byte account (about 0.005 SOL) plus fees. The table holds program addresses only.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { makePumpfunProvider } from '../src/launch/pumpfun.js';
import { devnetKeypair } from './devnet-wallet.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const cfg = loadConfig();
const i = process.argv.indexOf('--keypair');
const payer = i > 0 ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[i + 1], 'utf8')))) : devnetKeypair('demo-submitter');
if (i < 0 && cfg.launch.network !== 'devnet') throw new Error('without --keypair this script only runs on devnet');
const conn = new web3.Connection(cfg.launch.rpcUrl, 'confirmed');
const provider = makePumpfunProvider(cfg, { connection: conn });
const addresses = (await provider.staticAccounts()).map((a) => new web3.PublicKey(a));
console.log(`payer ${payer.publicKey.toBase58()} on ${cfg.launch.network}; ${addresses.length} static accounts`);

async function send(instructions) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, 'finalized');
  return sig;
}

const x = process.argv.indexOf('--extend');
if (x > 0) {
  const table = new web3.PublicKey(process.argv[x + 1]);
  const existing = (await conn.getAddressLookupTable(table)).value;
  if (!existing) throw new Error(`lookup table ${table.toBase58()} not found on ${cfg.launch.network}`);
  if (!existing.state.authority?.equals(payer.publicKey)) throw new Error(`the table's authority is ${existing.state.authority?.toBase58() ?? 'none (frozen)'}, not this signer`);
  const have = new Set(existing.state.addresses.map((a) => a.toBase58()));
  const missing = addresses.filter((a) => !have.has(a.toBase58()));
  console.log(`${table.toBase58()} holds ${have.size} accounts; ${missing.length} missing`);
  if (missing.length) {
    const sig = await send([web3.AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: table, addresses: missing })]);
    console.log(`extended (tx ${sig}); the new entries are usable from the next slot`);
  }
  console.log(`\nLAUNCH_LOOKUP_TABLE=${table.toBase58()}`);
} else {
  // A slot a little behind the tip: the program checks it against SlotHashes on the node that simulates, and the public
  // RPCs are load-balanced (devnet 2026-10-10: the tip itself was 'not a recent slot').
  const slot = (await conn.getSlot('confirmed')) - 30;
  const [createIx, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  const extendIx = web3.AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: table, addresses });
  const sig = await send([createIx, extendIx]);
  console.log(`created ${table.toBase58()} (tx ${sig})`);
  console.log(`\nLAUNCH_LOOKUP_TABLE=${table.toBase58()}`);
}
