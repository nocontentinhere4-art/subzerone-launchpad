// Devnet only: a throwaway test wallet for the end-to-end launch test (no real value). Kept in data/devnet/,
// which is git-ignored. Never use this for mainnet.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
const require = createRequire(import.meta.url);
const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');

export function devnetKeypair(name = 'test-wallet') {
  const dir = join(ROOT, 'data', 'devnet');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kp = devnetKeypair(process.argv[2]);
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  console.log('address', kp.publicKey.toBase58(), 'balance', (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL);
  if (process.argv.includes('--airdrop')) {
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log('airdropped', sig, 'balance', (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL);
    } catch (e) { console.log('airdrop failed:', e.message.slice(0, 200)); }
  }
}
