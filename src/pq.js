// The post-quantum registry (docs/APP-COMPOSER.md, block `pq`): a hash-chained, append-only log of what the launchpad
// did for one coin (its launch configuration, fee split, mint, every site version, the app's reveals, the owner's
// notes), each entry signed with ML-DSA-65 (FIPS 204, @noble/post-quantum, MIT) by a key that belongs to that project.
// The seed of the key is stored encrypted with APP_ENCRYPTION_KEY (like the X tokens); the public key is on the site,
// and the visitor's browser verifies every entry itself with the same library. What this is NOT: it does not make the
// coin or any Solana account quantum-safe (they use Ed25519); the page says so.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, sha256, now, HttpError, parseJson } from './util.js';
import { audit } from './db.js';

export const ALG = 'ML-DSA-65';
export const HEADER = 'SUBZERONE post-quantum registry v1';
const PAGE = 20;
const b64 = (u8) => Buffer.from(u8).toString('base64');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

export const pqAvailable = (cfg) => Boolean(cfg.encryptionKey);

/** The project's key: created on first use (32 random bytes of seed -> ML-DSA-65 keygen), seed kept encrypted. */
export function projectKey(db, cfg, project) {
  if (!pqAvailable(cfg)) throw new HttpError(503, 'pq_off', 'the post-quantum registry needs APP_ENCRYPTION_KEY on the server');
  let row = db.get('SELECT * FROM pq_keys WHERE project_id = ?', project.id);
  if (!row) {
    const seed = randomBytes(32), { publicKey } = ml_dsa65.keygen(seed);
    db.run('INSERT OR IGNORE INTO pq_keys (project_id, alg, public_key, seed_enc, created_at) VALUES (?, ?, ?, ?, ?)', project.id, ALG, b64(publicKey), encrypt(cfg.encryptionKey, seed), now());
    row = db.get('SELECT * FROM pq_keys WHERE project_id = ?', project.id);
  }
  return row;
}
const secretOf = (cfg, row) => ml_dsa65.keygen(new Uint8Array(decrypt(cfg.encryptionKey, row.seed_enc))).secretKey;

/** The exact text an entry signs. The browser rebuilds it from the entry's fields and checks it is the same. */
export function entryMessage({ slug, seq, kind, ref, at, payloadHash, prev }) {
  return [HEADER, `project: ${slug}`, `seq: ${seq}`, `kind: ${kind}`, `ref: ${ref}`, `at: ${new Date(at).toISOString()}`, `payload-sha256: ${payloadHash}`, `prev: ${prev}`].join('\n');
}

function append(db, cfg, project, key, secret, { kind, ref, at, payload }) {
  if (db.get('SELECT 1 FROM pq_entries WHERE project_id = ? AND kind = ? AND ref = ?', project.id, kind, ref)) return null;
  const last = db.get('SELECT seq, hash FROM pq_entries WHERE project_id = ? ORDER BY seq DESC LIMIT 1', project.id);
  const seq = (last?.seq || 0) + 1, payloadJson = canon(payload), payloadHash = sha256(payloadJson);
  const message = entryMessage({ slug: project.slug, seq, kind, ref, at, payloadHash, prev: last?.hash || 'genesis' });
  const signature = ml_dsa65.sign(new TextEncoder().encode(message), secret);
  db.run('INSERT INTO pq_entries (project_id, seq, kind, ref, at, payload_json, message, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, seq, kind, ref, at, payloadJson, message, sha256(message), b64(signature));
  return seq;
}

/** What the launchpad's own tables say happened, as registry events (oldest first). */
function events(db, project) {
  const out = [];
  for (const a of db.all(`SELECT * FROM fee_allocations WHERE project_id = ? AND status IN ('approved','locked','superseded') AND approved_at IS NOT NULL ORDER BY version`, project.id)) {
    out.push({ kind: 'fees.split', ref: a.id, at: a.approved_at, payload: { version: a.version, recipients: parseJson(a.recipients_json, []).map((r) => ({ label: r.label, wallet: r.wallet, bps: r.bps, role: r.role })),
      totalBps: a.total_bps, approvedBy: a.approved_by, statementSha256: a.approval_statement ? sha256(a.approval_statement) : null } });
  }
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', project.id);
  if (launch) {
    const intent = db.get('SELECT * FROM launch_intents WHERE id = ?', launch.intent_id);
    if (intent) out.push({ kind: 'launch.config', ref: intent.id, at: intent.created_at, payload: { provider: intent.provider, network: intent.network, configSha256: intent.config_hash, feeAllocation: intent.allocation_id, mint: intent.mint } });
    out.push({ kind: 'launch.mint', ref: launch.mint, at: launch.verified_at, payload: { mint: launch.mint, network: launch.network, provider: launch.provider, txSignature: launch.tx_signature, slot: launch.slot ?? null } });
  }
  for (const v of db.all(`SELECT version, sha256, created_at FROM site_versions WHERE project_id = ? AND build_status = 'ok' ORDER BY version`, project.id)) {
    out.push({ kind: 'site.version', ref: String(v.version), at: v.created_at, payload: { version: v.version, htmlSha256: v.sha256 } });
  }
  for (const r of db.all(`SELECT r.*, i.text, i.seq FROM app_reveals r LEFT JOIN app_items i ON i.id = r.item_id WHERE r.project_id = ? AND r.method != 'empty' ORDER BY r.slot_at`, project.id)) {
    out.push({ kind: 'app.reveal', ref: String(r.slot_at), at: r.created_at, payload: { slotAt: r.slot_at, item: r.item_id, number: r.seq ?? null, textSha256: r.text ? sha256(r.text) : null, method: r.method, proofSha256: sha256(r.proof_json), dev: !!r.dev } });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Append what is new (idempotent). Runs in one transaction so two requests cannot fork the chain. */
export function syncRegistry(db, cfg, project) {
  return db.tx(() => {
    const key = projectKey(db, cfg, project);
    let secret = null;
    const sign = (e) => { secret ||= secretOf(cfg, key); return append(db, cfg, project, key, secret, e); };
    if (!db.get(`SELECT 1 FROM pq_entries WHERE project_id = ? AND kind = 'registry.key'`, project.id)) {
      sign({ kind: 'registry.key', ref: key.public_key.slice(0, 32), at: key.created_at, payload: { alg: ALG, publicKey: key.public_key, project: project.slug } });
    }
    let added = 0;
    for (const e of events(db, project)) if (sign(e)) added++;
    return added;
  });
}

/** An owner's note, signed into the registry (plain text, moderated by the caller). */
export function announce(db, cfg, project, text, actor) {
  const t = now();
  const seq = db.tx(() => { const key = projectKey(db, cfg, project); return append(db, cfg, project, key, secretOf(cfg, key), { kind: 'owner.note', ref: `${t}`, at: t, payload: { text } }); });
  audit(db, { actor, kind: 'app', projectId: project.id, ideaId: project.idea_id, isPublic: true, message: `Signed a note into the post-quantum registry (#${seq})` });
  return { seq };
}

/** The public page of the registry: newest first, PAGE entries, `before` = a seq. */
export function registryView(db, cfg, project, { before } = {}) {
  syncRegistry(db, cfg, project);
  const key = projectKey(db, cfg, project);
  const b = Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
  const rows = db.all('SELECT * FROM pq_entries WHERE project_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', project.id, b, PAGE);
  const total = db.get('SELECT COUNT(*) n FROM pq_entries WHERE project_id = ?', project.id).n;
  return { alg: ALG, standard: 'FIPS 204', library: '@noble/post-quantum 0.7.1 (MIT)', header: HEADER, project: project.slug, publicKey: key.public_key, total,
    entries: rows.map((r) => ({ seq: r.seq, kind: r.kind, ref: r.ref, at: r.at, payload: r.payload_json, message: r.message, hash: r.hash, signature: r.signature })),
    next: rows.length === PAGE ? rows[rows.length - 1].seq : null };
}

/** Server-side check of the whole chain (tests, the room PC): every signature, every payload hash, every link. */
export function verifyRegistry(db, project) {
  const key = db.get('SELECT * FROM pq_keys WHERE project_id = ?', project.id);
  if (!key) return { ok: false, problems: ['no key'] };
  const pub = new Uint8Array(Buffer.from(key.public_key, 'base64')), problems = [];
  let prev = 'genesis';
  for (const r of db.all('SELECT * FROM pq_entries WHERE project_id = ? ORDER BY seq', project.id)) {
    const msg = entryMessage({ slug: project.slug, seq: r.seq, kind: r.kind, ref: r.ref, at: r.at, payloadHash: sha256(r.payload_json), prev });
    if (msg !== r.message) problems.push(`#${r.seq}: message does not match its fields`);
    if (!ml_dsa65.verify(new Uint8Array(Buffer.from(r.signature, 'base64')), new TextEncoder().encode(r.message), pub)) problems.push(`#${r.seq}: bad signature`);
    prev = sha256(r.message);
  }
  return { ok: problems.length === 0, problems };
}
