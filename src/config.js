// All configuration comes from the environment. Secrets never have defaults; a feature without its secret is off.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { isSolanaAddress } from './util.js';

export const ROOT = resolve(import.meta.dirname, '..');

// Canonical SUBZERONE facts. Never replaced, never regenerated.
export const SUB01 = Object.freeze({
  project: 'SUBZERONE',
  ticker: 'SUB-01',
  network: 'Solana',
  mint: '6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump',
  website: 'https://subzerone.live',
  x: 'https://x.com/SUBZERONE01',
  code: 'https://github.com/nocontentinhere4-art/sub-01-brain',
  pumpfun: 'https://pump.fun/coin/6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump',
});

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function loadConfig(env = process.env) {
  if (env === process.env && !env.LAUNCHPAD_NO_DOTENV) loadDotEnv(resolve(ROOT, '.env'));
  const e = (k, d = '') => (env[k] ?? d).toString().trim();
  const num = (k, d) => (e(k) === '' ? d : Number(e(k)));
  const deployEnv = e('DEPLOY_ENV', 'development');
  const cfg = {
    deployEnv,
    production: deployEnv === 'production',
    port: num('PORT', 8787),
    host: e('HOST', '127.0.0.1'),
    publicOrigin: e('PUBLIC_ORIGIN', `http://localhost:${num('PORT', 8787)}`),
    // generated project sites: <slug>.<projectsHost>; locally *.localhost resolves to 127.0.0.1
    projectsHost: e('PROJECTS_HOST', `projects.localhost:${num('PORT', 8787)}`),
    projectsScheme: e('PROJECTS_SCHEME', 'http'),
    dataDir: resolve(ROOT, e('DATA_DIR', 'data')),
    trustProxy: e('TRUST_PROXY') === '1',
    sessionDays: num('SESSION_DAYS', 7),
    nonceTtlS: num('AUTH_NONCE_TTL_S', 300),
    encryptionKey: e('APP_ENCRYPTION_KEY'),           // 32 bytes, base64; protects X tokens and launch mint keys
    // SUB-01's own wallet: the fixed 20% creator-fee row of every project (launch.js). Without it nothing launches.
    sub01FeeWallet: e('SUB01_FEE_WALLET'),
    // the city client's Vite build output; when set it is served at / and the launchpad home moves to /launchpad
    cityDist: e('CITY_DIST'),
    adminWallets: e('ADMIN_WALLETS').split(',').map((s) => s.trim()).filter(Boolean),
    brain: {
      url: e('BRAIN_URL'),                              // the SUB-01 live server, e.g. https://subzerone.live
      secret: e('LAUNCHPAD_BRAIN_SECRET'),
      publicRoomUrl: e('BRAIN_PUBLIC_URL', SUB01.website),
      timeoutMs: num('BRAIN_TIMEOUT_MS', 20000),
    },
    generator: {
      provider: e('GENERATOR', 'template'),             // template | anthropic
      anthropicKey: e('ANTHROPIC_API_KEY'),
      anthropicModel: e('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
      // USD per million tokens, from the provider's price page; used for the budget, set them when enabling a model
      priceIn: num('GENERATOR_PRICE_IN_PER_MTOK', 0),
      priceOut: num('GENERATOR_PRICE_OUT_PER_MTOK', 0),
      timeoutMs: num('GENERATOR_TIMEOUT_MS', 60000),
    },
    budgets: {
      globalDailyUsd: num('BUDGET_GLOBAL_DAILY_USD', 5),
      perProjectUsd: num('BUDGET_PER_PROJECT_USD', 1),
      maxActiveGenerations: num('MAX_ACTIVE_GENERATIONS', 3),
      maxIdeasPerWalletPerDay: num('MAX_IDEAS_PER_WALLET_PER_DAY', 3),
    },
    launch: {
      provider: e('LAUNCH_PROVIDER', 'mock'),            // mock | pumpfun
      network: e('SOLANA_NETWORK', 'devnet'),            // devnet | mainnet-beta (mock: ignored)
      rpcUrl: e('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
      requireAdminClearance: e('REQUIRE_ADMIN_CLEARANCE', '1') !== '0',
      confirmTimeoutS: num('LAUNCH_CONFIRM_TIMEOUT_S', 180),
      metadataUploader: e('METADATA_UPLOADER', 'self'),  // self: metadata JSON + image served by this app
      lookupTable: e('LAUNCH_LOOKUP_TABLE'),             // address lookup table with the static launch accounts
    },
    x: {
      clientId: e('X_CLIENT_ID'),
      clientSecret: e('X_CLIENT_SECRET'),
      redirectUri: e('X_REDIRECT_URI'),
    },
    market: { sub01RpcUrl: e('SUB01_MARKET_RPC_URL', 'https://api.mainnet-beta.solana.com') },
    backups: { keep: num('BACKUP_KEEP', 14), everyHours: num('BACKUP_EVERY_HOURS', 24) },
  };
  if (cfg.sub01FeeWallet && !isSolanaAddress(cfg.sub01FeeWallet)) throw new Error('SUB01_FEE_WALLET is not a valid Solana address');
  if (cfg.cityDist && !isAbsolute(cfg.cityDist)) throw new Error('CITY_DIST must be an absolute path');
  if (cfg.production) {
    const missing = [];
    if (!cfg.encryptionKey) missing.push('APP_ENCRYPTION_KEY');
    if (!cfg.publicOrigin.startsWith('https://')) missing.push('PUBLIC_ORIGIN (https)');
    if (cfg.launch.provider === 'mock') missing.push('LAUNCH_PROVIDER (mock is not allowed in production)');
    if (missing.length) throw new Error(`production config incomplete: ${missing.join(', ')}`);
  }
  return cfg;
}
