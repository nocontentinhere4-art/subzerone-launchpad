// Wallet connection through the Wallet Standard (Phantom, Solflare, Backpack and others register themselves).
// Only three wallet features are used: connect, signMessage (sign-in, mock launches) and signTransaction (launch).
// We never ask for a seed phrase or a private key, and we never move funds without a transaction you review.
import { api, b58encode, toB64, fromB64 } from './lib.js';

const wallets = new Map();
const listeners = new Set();
let current = null;   // { wallet, account }

function register(...ws) {
  for (const w of ws) {
    const solana = (w.chains || []).some((c) => String(c).startsWith('solana:'));
    if (solana && w.features?.['standard:connect'] && w.features?.['solana:signMessage']) wallets.set(w.name, w);
  }
  listeners.forEach((fn) => fn());
  return () => {};
}
const registerApi = Object.freeze({ register });
window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registerApi); } catch { /* a broken wallet */ } });
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registerApi }));

export const onWallets = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const listWallets = () => [...wallets.values()].map((w) => ({ name: w.name, icon: w.icon }));
export const connected = () => current && { name: current.wallet.name, address: current.account.address };

export async function connect(name) {
  const w = wallets.get(name);
  if (!w) throw new Error('wallet not found');
  const { accounts } = await w.features['standard:connect'].connect();
  const account = accounts?.[0];
  if (!account) throw new Error('the wallet shared no account');
  current = { wallet: w, account };
  return account.address;
}

/** Sign-in: the server's message, signed by the wallet. No transaction, no funds. */
export async function signIn(name) {
  const address = await connect(name);
  const n = await api('/api/auth/nonce', { method: 'POST', body: { wallet: address } });
  const [res] = await current.wallet.features['solana:signMessage'].signMessage({ account: current.account, message: new TextEncoder().encode(n.message) });
  await api('/api/auth/verify', { method: 'POST', body: { wallet: address, nonce: n.nonce, signature: b58encode(res.signature) } });
  return address;
}

export async function signMessageText(text) {
  if (!current) throw new Error('connect your wallet first');
  const [res] = await current.wallet.features['solana:signMessage'].signMessage({ account: current.account, message: new TextEncoder().encode(text) });
  return b58encode(res.signature);
}

/** The reviewed transaction (base64) -> signed bytes (base64). The server broadcasts it after checking it. */
export async function signTransaction(txBase64, network) {
  if (!current) throw new Error('connect your wallet first');
  const feature = current.wallet.features['solana:signTransaction'];
  if (!feature) throw new Error(`${current.wallet.name} cannot sign transactions through the Wallet Standard`);
  const chain = network === 'mainnet-beta' ? 'solana:mainnet' : `solana:${network}`;
  const [res] = await feature.signTransaction({ account: current.account, transaction: fromB64(txBase64), chain });
  return toB64(res.signedTransaction);
}
