// One-off (tools/start.sh): PadPad was built before launchpad families existed (a plain launchpad with a map). Queue one
// full rebuild (rewrite.js: app, tools, idea check, words; name, ticker and art stay) as its author. Idempotent: the job
// key is fixed, so a restart never queues it twice. Skipped once the coin is launched or its art is locked.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { enqueue } from '../src/jobs.js';
import { artLock } from '../src/art-choice.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
const p = db.get(`SELECT * FROM projects WHERE slug = 'padpad'`);
const idea = p && db.get('SELECT * FROM ideas WHERE id = ?', p.idea_id);
if (!p || !idea) console.log('rebuild-padpad: no padpad project');
else {
  const lock = artLock(db, p, idea);
  if (lock) console.log(`rebuild-padpad: skipped (${lock})`);
  else {
    const j = enqueue(db, { type: 'rewrite_copy', key: `rebuild:padpad:families:2`, ideaId: idea.id, projectId: p.id, payload: { by: idea.owner_wallet } });
    console.log(`rebuild-padpad: job ${j.id} ${j.status}`);
  }
}
