// Development test harness: paste/evaluate in a page on localhost to register a throwaway Wallet Standard wallet
// ("Test Wallet (dev)") backed by an in-page Ed25519 key. Lets the UI flow be exercised without a browser extension.
// It signs messages only (sign-in, mock launches). Never use it outside local development.
(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const b of pub) n = (n << 8n) + BigInt(b);
  let address = ''; while (n > 0n) { address = A[Number(n % 58n)] + address; n /= 58n; }
  for (const b of pub) { if (b === 0) address = '1' + address; else break; }
  const account = { address, publicKey: pub, chains: ['solana:devnet', 'solana:mainnet'], features: ['solana:signMessage'] };
  const wallet = {
    version: '1.0.0', name: 'Test Wallet (dev)', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAxIDEnPjxyZWN0IHdpZHRoPScxJyBoZWlnaHQ9JzEnIGZpbGw9JyNiOThjZmYnLz48L3N2Zz4=',
    chains: ['solana:devnet', 'solana:mainnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, message)) }] },
    },
  };
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet) }));
  window.__testWallet = address;
  return address;
})();
