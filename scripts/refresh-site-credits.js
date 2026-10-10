// One-off, idempotent maintenance (tools/start.sh runs it after the server listens): coin sites built before
// 2026-10-10 carry "built by SUB-01 · subzerone.live" on their banner and the old footer. The owner wants them to say
// they were made on the launchpad (city.subzerone.live). The live version's HTML is rebuilt from its stored spec with
// the current render-child.js (same spec, so the author's approval still describes the same content) and the banner
// gets a new asset version with the new credit line. Already-refreshed projects are skipped.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { siteContext, sandboxBuild, validateHtml, bannerCredit } from '../src/site.js';
import { DEFAULT_CREDIT } from '../src/art.js';
import { id, now, sha256, parseJson } from '../src/util.js';
import { networkLabel } from '../src/generator.js';

const cfg = loadConfig();

const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const credit = bannerCredit(cfg);
// Older brain answers said "20k-neuron network on CPU" whatever size ran (the label was fixed in the brain on 2026-10-10);
// the record carries n_neurons, so the stored wording follows it: the brain record, the idea's status note, the site spec.
let relabelled = 0;
for (const ev of dbAll(`SELECT id, idea_id, brain_json FROM evaluations WHERE instr(brain_json, '-neuron network on') > 0`)) {
  const rec = parseJson(ev.brain_json); const sp = rec?.vote?.spiking; if (!sp?.used || !sp.n_neurons) continue;
  const right = networkLabel(sp), wrong = String(sp.network || ''); if (!wrong || wrong === right) continue;
  sp.network = right;
  db.run('UPDATE evaluations SET brain_json = ? WHERE id = ?', JSON.stringify(rec), ev.id);
  db.run('UPDATE ideas SET status_note = replace(status_note, ?, ?) WHERE id = ? AND instr(coalesce(status_note, \'\'), ?) > 0', wrong, right, ev.idea_id, wrong);
  for (const sv of dbAll(`SELECT s.id, s.spec_json FROM site_versions s JOIN projects p ON p.id = s.project_id WHERE p.idea_id = ? AND instr(s.spec_json, ?) > 0`, ev.idea_id, wrong)) {
    db.run('UPDATE site_versions SET spec_json = ?, html = replace(coalesce(html, \'\'), ?, ?) WHERE id = ?', sv.spec_json.replaceAll(wrong, right), wrong, right, sv.id);
  }
  relabelled++;
}
function dbAll(sql, ...args) { return db.all(sql, ...args); }
let sites = 0, banners = 0;
for (const p of db.all('SELECT * FROM projects WHERE live_site_version IS NOT NULL')) {
  const row = db.get(`SELECT * FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, p.id, p.live_site_version);
  if (row && !(row.html.includes('Made on the SUBZERONE launchpad') && row.html.includes('rel="icon"'))) {   // old footer or no favicon
    try {
      const context = siteContext(db, cfg, p, { preview: !db.get('SELECT 1 FROM launches WHERE project_id = ?', p.id) });
      const html = await sandboxBuild({ spec: parseJson(row.spec_json), context });
      const check = validateHtml(html, context.links.map((l) => l.href));
      if (check.ok) { db.run('UPDATE site_versions SET html = ?, sha256 = ? WHERE id = ?', html, sha256(html), row.id); sites++; }
      else console.error(`refresh-site-credits: ${p.slug} v${row.version} not refreshed: ${check.problems.join('; ')}`);
    } catch (e) { console.error(`refresh-site-credits: ${p.slug}: ${e.message}`); }
  }
  const a = db.get(`SELECT * FROM assets WHERE project_id = ? AND kind = 'banner' ORDER BY version DESC LIMIT 1`, p.id);
  if (a) {
    const svg = Buffer.from(a.body).toString('utf8');
    if (svg.includes(DEFAULT_CREDIT) && !svg.includes(credit)) {
      const body = Buffer.from(svg.replaceAll(DEFAULT_CREDIT, credit));
      db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id('asset'), p.id, 'banner', a.version + 1, a.mime, body, sha256(body), 'credit-refresh/1', now());
      banners++;
    }
  }
}
console.log(`refresh-site-credits: ${sites} site(s) rebuilt, ${banners} banner(s) re-credited (${credit}), ${relabelled} vote record(s) relabelled`);
