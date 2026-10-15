// Offline snapshot normalization. Never signs, broadcasts or loads wallet keys.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeRewardSnapshot } from '../src/rewards-snapshot.js';
const args = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
if (!get('--input') || !get('--output')) throw Error('Usage: node scripts/rewards-snapshot.js --input finalized-rpc-export.json --exclusions exclusion-reasons.json --output snapshot-review.json');
const evidence = JSON.parse(readFileSync(get('--input'), 'utf8'));
const exclusions = get('--exclusions') ? JSON.parse(readFileSync(get('--exclusions'), 'utf8')) : [];
const review = normalizeRewardSnapshot(evidence, exclusions);
writeFileSync(get('--output'), JSON.stringify(review, null, 2));
console.log(JSON.stringify({ accountCount: review.accountCount, owners: review.positiveBalanceOwners, unresolved: review.unresolved.length, readyForAllocation: review.readyForAllocation }));
