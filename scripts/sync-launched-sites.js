// Boot (tools/start.sh): a coin launched while its "launched" rebuild was held back by SUB-01's QA (PadPad, 2026-10-12)
// kept a live page that says "not launched". Every launched coin whose live page still carries the pre-launch badge gets
// one build_site with reason 'launched' (it goes live whatever the QA says: site-qa.js mustPublish). Idempotent per version.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { enqueue } from '../src/jobs.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const rows = db.all(`SELECT p.id, p.slug, p.idea_id, p.live_site_version v, s.html FROM launches l JOIN projects p ON p.id = l.project_id
  JOIN site_versions s ON s.project_id = p.id AND s.version = p.live_site_version WHERE l.verified_at IS NOT NULL`);
let n = 0;
for (const r of rows) {
  if (!/class="state pre"/.test(r.html || '')) continue;
  enqueue(db, { type: 'build_site', key: `site:launched:${r.id}:sync:${r.v}`, ideaId: r.idea_id, projectId: r.id, payload: { reason: 'launched' } });
  n += 1; console.log(`sync-launched-sites: ${r.slug} v${r.v} still says not launched: rebuild queued`);
}
console.log(`sync-launched-sites: ${n} queued of ${rows.length} launched`);
