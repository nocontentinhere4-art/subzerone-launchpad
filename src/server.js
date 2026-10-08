// Web process. Run the worker (src/worker.js) alongside it; `npm run dev` starts both.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { createApp } from './app.js';
import { log } from './log.js';

export function start(cfg = loadConfig()) {
  const db = openDb(join(cfg.dataDir, 'launchpad.db'));
  const applied = migrate(db);
  if (applied.length) log.info('migrations applied', { applied });
  const server = createServer(createApp({ cfg, db }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(cfg.port, cfg.host, () => log.info('launchpad listening', { url: cfg.publicOrigin, env: cfg.deployEnv, provider: cfg.launch.provider }));
  return { server, db };
}

if (import.meta.url === `file://${process.argv[1]}`) start();
