// One-off, idempotent maintenance (tools/start.sh runs it after backfill-site-tools.js): launched coins whose live site
// has no idea app get the one SUB-01 composes from their idea (composer.js; the model only when ANTHROPIC_API_KEY is
// set, the rules otherwise) as a new site version, recorded publicly as "SUB-01 built the app". Sites that carry an
// `app` key at all (even null: the author switched it off) are skipped.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backfillApps } from '../src/app-api.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const out = await backfillApps(db, cfg);
for (const a of out.built) console.log(`backfill-app: ${a.slug} -> v${a.version} ${a.kind} (${a.source}): ${a.summary}${a.replaced.length ? `; replaces ${a.replaced.join(', ')}` : ''}`);
for (const f of out.failed) console.error(`backfill-app: ${f.slug} not changed: ${f.error}`);
console.log(`backfill-app: ${out.built.length} site(s) got an app, ${out.skipped} already had one, ${out.failed.length} failed`);
