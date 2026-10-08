// One-time operator setup: create the address lookup table that holds the static pump.fun accounts, so a launch with a
// locked multi-recipient fee split fits in ONE transaction (1232-byte limit). Prints LAUNCH_LOOKUP_TABLE.
//   node scripts/lookup-table.js                      devnet, pays with the throwaway test wallet in data/devnet/
//   node scripts/lookup-table.js --keypair <file>     any network (SOLANA_RPC_URL); the operator's own keypair file,
//                                                    read locally and never stored or sent anywhere by the app
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

const slot = await conn.getSlot('finalized');
const [createIx, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
const extendIx = web3.AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: table, addresses });
const { blockhash } = await conn.getLatestBlockhash('confirmed');
const msg = new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [createIx, extendIx] }).compileToV0Message();
const tx = new web3.VersionedTransaction(msg);
tx.sign([payer]);
const sig = await conn.sendTransaction(tx);
await conn.confirmTransaction(sig, 'finalized');
console.log(`created ${table.toBase58()} (tx ${sig})`);
console.log(`\nLAUNCH_LOOKUP_TABLE=${table.toBase58()}`);
