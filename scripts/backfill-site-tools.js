// One-off, idempotent maintenance (tools/start.sh runs it after the server listens, like refresh-site-credits.js):
// launched coins whose live site predates the site kit (2026-10-12) get SUB-01's tool pick as a new site version,
// recorded publicly as "SUB-01 added tools". Sites that already carry a `tools` list (even an empty one) are skipped.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backfillTools } from '../src/tool-api.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const out = await backfillTools(db, cfg);
for (const a of out.added) console.log(`backfill-site-tools: ${a.slug} -> v${a.version} (${a.tools.join(', ')})`);
for (const f of out.failed) console.error(`backfill-site-tools: ${f.slug} not changed: ${f.error}`);
console.log(`backfill-site-tools: ${out.added.length} site(s) got tools, ${out.skipped} already had them, ${out.failed.length} failed`);
