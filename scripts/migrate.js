import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
console.log('applied:', migrate(db).join(', ') || 'nothing new');
