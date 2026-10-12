// One-off, idempotent maintenance (tools/start.sh runs it after backfill-app.js, so the app has already replaced the
// generic tools it does better): launched coins whose live site lacks any holder tool (trades, holders, dev watch, fees,
// alerts) get them appended as a new site version, recorded publicly as "SUB-01 added holder tools". Once per coin: the
// audit line is the marker, so a coin whose author later removes them, or switched every tool off, is left alone.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backfillHolderTools } from '../src/holder-tools.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const out = await backfillHolderTools(db, cfg);
for (const a of out.added) console.log(`backfill-holder-tools: ${a.slug} -> v${a.version} (${a.tools.join(', ')})`);
for (const f of out.failed) console.error(`backfill-holder-tools: ${f.slug} not changed: ${f.error}`);
console.log(`backfill-holder-tools: ${out.added.length} site(s) got the holder tools, ${out.skipped} skipped, ${out.failed.length} failed`);
