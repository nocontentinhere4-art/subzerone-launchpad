import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, backup } from '../src/db.js';
const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
console.log('backup:', backup(db, join(cfg.dataDir, 'backups'), cfg.backups.keep));
