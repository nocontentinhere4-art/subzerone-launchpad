// One-off, idempotent maintenance (tools/start.sh, after the backfills): coin sites still on the pre-redesign stylesheet
// (site-kit.v1.css) are rebuilt from their own spec in the black-and-white design (docs/DESIGN.md) as a new version,
// statically checked, set live, and a browser QA is queued for the worker (site-qa.js refreshSiteDesign).
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { refreshSiteDesign } from '../src/site-qa.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const out = await refreshSiteDesign(db, cfg);
for (const a of out.rebuilt) console.log(`refresh-site-design: ${a.slug} -> v${a.version} ${a.live ? 'live' : 'held'} (QA: ${a.qa})`);
for (const f of out.failed) console.error(`refresh-site-design: ${f.slug} not changed: ${f.error}`);
console.log(`refresh-site-design: ${out.rebuilt.length} site(s) rebuilt, ${out.skipped} skipped, ${out.failed.length} failed`);
