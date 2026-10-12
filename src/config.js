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

/** Comma list (or one value) of short printable strings, for public text. */
function list(raw, max, len, name, split = true) {
  const xs = (split ? raw.split(',') : [raw]).map((x) => x.trim()).filter(Boolean);
  if (xs.length > max || xs.some((x) => x.length > len || /[\u0000-\u001f\u007f<>`]/.test(x))) throw new Error(`${name}: at most ${max} values of ${len} printable characters`);
  return xs;
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
      // a healthy brain answers in well under a second; an idea must not wait longer than this on a sick one
      timeoutMs: num('BRAIN_TIMEOUT_MS', 8000),
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
    // the coin art (coinart.js): black-and-white lettermarks. Higgsfield first, Recraft's own API second, the local
    // generator (no AI) when neither key is set or a provider fails. Model paths: docs/COIN-ART.md says what to check.
    art: {
      // the pair, or one combined HF_API_KEY="<id>:<secret>" (the form the Authorization header takes)
      hfKeyId: e('HF_API_KEY_ID') || (e('HF_API_KEY').includes(':') ? e('HF_API_KEY').slice(0, e('HF_API_KEY').indexOf(':')).trim() : ''),
      hfKeySecret: e('HF_API_KEY_SECRET') || (e('HF_API_KEY').includes(':') ? e('HF_API_KEY').slice(e('HF_API_KEY').indexOf(':') + 1).trim() : ''),
      hfBase: e('HF_API_BASE', 'https://api.higgsfield.ai'),
      hfLogoModel: e('HF_LOGO_MODEL', 'recraft/v4.1/text-to-image'),
      hfBannerModel: e('HF_BANNER_MODEL', 'recraft/v4.1/text-to-image'),
      hfParams: e('HF_PARAMS'),                          // JSON merged into every Higgsfield body (a model's extra fields)
      recraftKey: e('RECRAFT_API_KEY'),
      recraftModel: e('RECRAFT_MODEL', 'recraftv4_1_vector'),
      providerBanners: e('ART_PROVIDER_BANNERS') === '1', // 0: banners are composed around the logo (always a matching pair)
      priceUsd: num('ART_PRICE_USD_PER_IMAGE', 0),       // budget accounting per provider image, from the price page
      timeoutMs: num('ART_TIMEOUT_MS', 45000),
      dir: resolve(ROOT, e('ART_DIR', 'art')),           // owner-supplied art, art/<name>/ (coinart.js premadeArt)
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
      maxInitialBuySol: num('MAX_INITIAL_BUY_SOL', 5),   // cap of the author's dev buy (launch.js caps it at 5 SOL regardless)
    },
    x: {
      clientId: e('X_CLIENT_ID'),
      clientSecret: e('X_CLIENT_SECRET'),
      redirectUri: e('X_REDIRECT_URI'),
    },
    market: { sub01RpcUrl: e('SUB01_MARKET_RPC_URL', 'https://api.mainnet-beta.solana.com') },
    // launched coins' stats for the city's building lights (coin-stats.js). Holders need Helius; without it they are null.
    coinStats: {
      enabled: e('COIN_STATS', '1') !== '0',
      heliusUrl: e('HELIUS_URL') || (e('HELIUS_API_KEY') ? `https://mainnet.helius-rpc.com/?api-key=${e('HELIUS_API_KEY')}` : ''),
      heliusDailyPages: num('HELIUS_DAILY_PAGES', 1000),     // DAS calls a day (1,000 accounts each); ≈ 10 credits per call
      dexGapMs: num('DEXSCREENER_MIN_GAP_MS', 2000),          // one DexScreener call per this many ms, all coins together (≤ 30/min)
    },
    // the coin sites' holder tools (onchain.js, holder-tools.js): read-only chain reads. RPC: ONCHAIN_RPC_URL, else Helius
    // (mainnet), else SOLANA_RPC_URL when the coin is on that network, else the public endpoint. Bounded per day.
    onchain: { rpcUrl: e('ONCHAIN_RPC_URL'), dailyCalls: num('ONCHAIN_DAILY_CALLS', 15000), txPerPoll: num('ONCHAIN_TX_PER_POLL', 30),
      minGapMs: e('ONCHAIN_MIN_GAP_MS') ? num('ONCHAIN_MIN_GAP_MS', 110) : null },     // pacing between calls; default by endpoint
    backups: { keep: num('BACKUP_KEEP', 14), everyHours: num('BACKUP_EVERY_HOURS', 24) },
    // the app composer's dev-only "reveal now" trigger (app-api.js); refused in production whatever the variable says
    appDevTrigger: e('APP_DEV_TRIGGER') === '1' && deployEnv !== 'production',
    // GET /api/disclosure (trust.js): the datasets SUB-01's brain model was derived from, and who operates it
    trust: { datasets: list(e('SUB01_DATASETS'), 20, 80, 'SUB01_DATASETS'), operatorName: e('OPERATOR_NAME') ? list(e('OPERATOR_NAME'), 1, 80, 'OPERATOR_NAME', false)[0] : null },
  };
  if (cfg.sub01FeeWallet && !isSolanaAddress(cfg.sub01FeeWallet)) throw new Error('SUB01_FEE_WALLET is not a valid Solana address');
  if (cfg.cityDist && !isAbsolute(cfg.cityDist)) throw new Error('CITY_DIST must be an absolute path');
  if (cfg.onchain.rpcUrl && !/^https:\/\//.test(cfg.onchain.rpcUrl)) throw new Error('ONCHAIN_RPC_URL must be an https:// URL');
  if (cfg.coinStats.heliusUrl && !/^https:\/\/[^/?#]+\.helius-rpc\.com\//.test(cfg.coinStats.heliusUrl)) throw new Error('HELIUS_URL must be an https://…helius-rpc.com/ URL');
  if (cfg.production) {
    const missing = [];
    if (!cfg.encryptionKey) missing.push('APP_ENCRYPTION_KEY');
    if (!cfg.publicOrigin.startsWith('https://')) missing.push('PUBLIC_ORIGIN (https)');
    if (cfg.launch.provider === 'mock') missing.push('LAUNCH_PROVIDER (mock is not allowed in production)');
    if (missing.length) throw new Error(`production config incomplete: ${missing.join(', ')}`);
  }
  return cfg;
}
