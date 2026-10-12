import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchRpc } from '../src/config.js';

test('launch RPC: the public mainnet endpoint becomes Helius when a key exists; anything else stays', () => {
  assert.equal(launchRpc('https://api.mainnet-beta.solana.com', 'mainnet-beta', 'abcd-1234-efgh'), 'https://mainnet.helius-rpc.com/?api-key=abcd-1234-efgh');
  assert.equal(launchRpc('https://api.mainnet-beta.solana.com/', 'mainnet-beta', ''), 'https://api.mainnet-beta.solana.com/');
  assert.equal(launchRpc('https://my.rpc.example/x', 'mainnet-beta', 'abcd-1234-efgh'), 'https://my.rpc.example/x');
  assert.equal(launchRpc('https://api.devnet.solana.com', 'devnet', 'abcd-1234-efgh'), 'https://api.devnet.solana.com');
  assert.equal(launchRpc('https://api.mainnet-beta.solana.com', 'mainnet-beta', 'bad key/with?chars'), 'https://api.mainnet-beta.solana.com');
});
