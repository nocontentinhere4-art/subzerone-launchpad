// Idea submission: validation, versions, uploads, publishing. Submissions are untrusted text; links are stored as
// text and never fetched by the server; uploaded images are checked by their bytes and served inert.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit, isPaused } from './db.js';
import { enqueue } from './jobs.js';
import { transition } from './states.js';
import { id, now, sha256, isSolanaAddress, HttpError, parseJson, utcDay } from './util.js';
import { SUB01 } from './config.js';
import { claimPlot, validatePlotId } from './world.js';
import { pinHash } from './rituals.js';

export const LIMITS = { title: [3, 80], concept: [20, 1500], name: 32, ticker: [2, 10], links: 5, uploads: 3,
  uploadBytes: 1_500_000 };

// addresses that must never receive fees: the SUB-01 mint and well-known programs
const NOT_A_WALLET = new Set([SUB01.mint, '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']);

const clean = (s) => String(s ?? '').normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim();

export function validateReceivingWallet(w) {
  const v = clean(w);
  if (!isSolanaAddress(v)) throw new HttpError(400, 'bad_receiving_wallet', 'receiving wallet is not a valid Solana address');
  if (NOT_A_WALLET.has(v)) throw new HttpError(400, 'bad_receiving_wallet', 'that address is a token or program, not a wallet');
  return v;
}

export function validateIdea(input) {
  const errors = {};
  const title = clean(input.title);
  const concept = clean(input.concept);
  const name = clean(input.nameSuggestion);
  const ticker = clean(input.tickerSuggestion).replace(/^\$/, '').toUpperCase();
  if (title.length < LIMITS.title[0] || title.length > LIMITS.title[1]) errors.title = `${LIMITS.title[0]}–${LIMITS.title[1]} characters`;
  if (concept.length < LIMITS.concept[0] || concept.length > LIMITS.concept[1]) errors.concept = `${LIMITS.concept[0]}–${LIMITS.concept[1]} characters`;
  if (name.length > LIMITS.name) errors.nameSuggestion = `at most ${LIMITS.name} characters`;
  if (ticker && !new RegExp(`^[A-Z0-9]{${LIMITS.ticker[0]},${LIMITS.ticker[1]}}$`).test(ticker)) errors.tickerSuggestion = '2–10 letters or digits';
  if (ticker === 'SUB01' || ticker === 'SUB-01') errors.tickerSuggestion = 'SUB-01 is taken: it is SUB-01\'s own token';
  const links = (Array.isArray(input.links) ? input.links : []).map(clean).filter(Boolean);
  if (links.length > LIMITS.links) errors.links = `at most ${LIMITS.links} links`;
  for (const l of links) {
    let u;
    try { u = new URL(l); } catch { errors.links = 'links must be full https:// URLs'; break; }
    if (u.protocol !== 'https:' || l.length > 300 || u.username || u.password) { errors.links = 'links must be https:// URLs without credentials'; break; }
  }
  const c = input.contacts || {};
  const contacts = {};
  const x = clean(c.x).replace(/^@/, '');
  const tg = clean(c.telegram).replace(/^@/, '');
  if (x) { if (/^[A-Za-z0-9_]{1,15}$/.test(x)) contacts.x = x; else errors.contacts = 'X handle: letters, digits, _ (max 15)'; }
  if (tg) { if (/^[A-Za-z0-9_]{5,32}$/.test(tg)) contacts.telegram = tg; else errors.contacts = 'Telegram: letters, digits, _ (5–32)'; }
  let receivingWallet = null;
  try { receivingWallet = validateReceivingWallet(input.receivingWallet); } catch (e) { errors.receivingWallet = e.message; }
  if (input.rightsConfirmed !== true) errors.rightsConfirmed = 'required';
  if (Object.keys(errors).length) throw new HttpError(400, 'invalid', 'please fix the highlighted fields', { errors });
  return { title, concept, nameSuggestion: name || null, tickerSuggestion: ticker || null, links, contacts, receivingWallet };
}

const MAGIC = [
  ['image/png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))],
  ['image/webp', (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Base64 image -> {mime, bytes, sha}. SVG and anything else is refused (SVG can carry script). */
export function sniffImage(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'bad_upload', 'empty file');
  if (buf.length > LIMITS.uploadBytes) throw new HttpError(413, 'too_large', 'images up to 1.5 MB');
  const hit = MAGIC.find(([, test]) => test(buf));
  if (!hit) throw new HttpError(415, 'bad_type', 'PNG, JPEG, GIF or WebP only');
  return { mime: hit[0], buf, sha: sha256(buf) };
}

export function uploadPath(dataDir, sha, mime) {
  return join(dataDir, 'uploads', `${sha}.${EXT[mime]}`);
}

export function submitIdea(db, cfg, wallet, input) {
  if (isPaused(db, 'submissions')) throw new HttpError(503, 'paused', 'submissions are paused right now');
  const v = validateIdea(input);
  const images = (Array.isArray(input.images) ? input.images : []).slice(0, LIMITS.uploads + 1);
  if (images.length > LIMITS.uploads) throw new HttpError(400, 'invalid', `at most ${LIMITS.uploads} images`);
  const files = images.map(sniffImage);
  const plotId = input.plotId == null || input.plotId === '' ? null : validatePlotId(input.plotId);
  const t = now();
  const today = db.get(`SELECT COUNT(*) n FROM ideas WHERE owner_wallet = ? AND created_at >= ?`, wallet, Date.parse(utcDay(t)));
  if (today.n >= cfg.budgets.maxIdeasPerWalletPerDay) {
    throw new HttpError(429, 'daily_limit', `${cfg.budgets.maxIdeasPerWalletPerDay} ideas per wallet per day`);
  }
  const ideaId = id('idea');
  return db.tx(() => {
    // the ema: version 1 pinned with its hash before anything is decided (rituals.js; proof of priority for the author)
    db.run(`INSERT INTO ideas (id, owner_wallet, status, status_note, created_at, updated_at, pinned_hash, pinned_at)
            VALUES (?, ?, 'submitted', 'waiting for SUB-01', ?, ?, ?, ?)`, ideaId, wallet, t, t, pinHash(v.title, v.concept, 1, wallet), t);
    insertVersion(db, ideaId, 1, v, wallet, t);
    if (plotId) claimPlot(db, { plotId, kind: 'project', wallet, ideaId });   // same transaction: no idea without its plot
    mkdirSync(join(cfg.dataDir, 'uploads'), { recursive: true });
    for (const f of files) {
      const p = uploadPath(cfg.dataDir, f.sha, f.mime);
      if (!existsSync(p)) writeFileSync(p, f.buf, { mode: 0o600 });
      db.run(`INSERT INTO uploads (id, idea_id, sha256, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(idea_id, sha256) DO NOTHING`, id('up'), ideaId, f.sha, f.mime, f.buf.length, t);
    }
    audit(db, { actor: `wallet:${wallet}`, kind: 'status', ideaId, isPublic: true,
      message: 'Dropped in his room', data: { version: 1, receiving_wallet: v.receivingWallet } });
    enqueue(db, { type: 'evaluate', key: `evaluate:${ideaId}:v1`, ideaId, payload: { version: 1 } });
    return ideaId;
  });
}

function insertVersion(db, ideaId, version, v, wallet, t) {
  const content = JSON.stringify([v.title, v.concept, v.nameSuggestion, v.tickerSuggestion, v.links, v.contacts, v.receivingWallet]);
  db.run(`INSERT INTO idea_versions (id, idea_id, version, title, concept, name_suggestion, ticker_suggestion,
            links_json, contacts_json, receiving_wallet, rights_confirmed, authored_by, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  id('iv'), ideaId, version, v.title, v.concept, v.nameSuggestion, v.tickerSuggestion, JSON.stringify(v.links),
  JSON.stringify(v.contacts), v.receivingWallet, wallet, sha256(content), t);
}

const EDITABLE = new Set(['submitted', 'evaluating', 'selected', 'generating', 'preview_ready', 'approved']);

/** A new version. The original stays. The receiving wallet can change only before the launch is prepared. */
export function editIdea(db, ideaId, wallet, input) {
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
  if (!idea || idea.owner_wallet !== wallet) throw new HttpError(404, 'not_found');
  if (!EDITABLE.has(idea.status)) throw new HttpError(409, 'locked', 'this idea can no longer be edited');
  const cur = currentVersion(db, ideaId);
  const v = validateIdea({ ...input, rightsConfirmed: input.rightsConfirmed });
  const t = now();
  return db.tx(() => {
    const version = idea.current_version + 1;
    insertVersion(db, ideaId, version, v, wallet, t);
    db.run('UPDATE ideas SET current_version = ?, updated_at = ? WHERE id = ?', version, t, ideaId);
    const walletChanged = v.receivingWallet !== cur.receiving_wallet;
    audit(db, { actor: `wallet:${wallet}`, kind: 'edit', ideaId, isPublic: true,
      message: walletChanged ? `Version ${version}: receiving wallet changed by the submitter` : `Version ${version} saved`,
      data: { version, receiving_wallet_from: walletChanged ? cur.receiving_wallet : undefined,
        receiving_wallet_to: walletChanged ? v.receivingWallet : undefined } });
    if (walletChanged) {
      // an approved allocation that names the old wallet is no longer valid: back to draft, the submitter re-approves
      const p = db.get('SELECT id FROM projects WHERE idea_id = ?', ideaId);
      if (p) {
        // a new draft with the submitter row moved to the new wallet (collaborators kept unless they collide with it;
        // the mandatory SUB-01 row is always kept)
        const prev = db.get(`SELECT * FROM fee_allocations WHERE project_id = ? AND status IN ('draft','approved') ORDER BY version DESC LIMIT 1`, p.id);
        let rows = prev ? parseJson(prev.recipients_json, []) : [];
        rows = rows.map((r) => (r.role === 'submitter' ? { ...r, wallet: v.receivingWallet } : r));
        if (!rows.some((r) => r.role === 'sub01') || rows.filter((r) => r.wallet === v.receivingWallet).length > 1) {
          const sub01 = rows.find((r) => r.role === 'sub01') || { label: 'SUB-01', wallet: null, bps: 2000, role: 'sub01' };
          rows = [{ label: 'Idea submitter', wallet: v.receivingWallet, bps: 10000 - sub01.bps, role: 'submitter' }, sub01];
        }
        db.run(`UPDATE fee_allocations SET status = 'superseded' WHERE project_id = ? AND status IN ('draft','approved')`, p.id);
        const nv = (db.get('SELECT MAX(version) n FROM fee_allocations WHERE project_id = ?', p.id)?.n || 0) + 1;
        db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at)
                VALUES (?, ?, ?, ?, 10000, 'draft', ?)`, id('alloc'), p.id, nv, JSON.stringify(rows), t);
        db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL WHERE id = ?', p.id);
        if (idea.status === 'approved') {
          transition(db, ideaId, 'approved', 'preview_ready', { actor: `wallet:${wallet}`,
            note: 'receiving wallet changed: review the fee allocation again' });
        }
      }
    }
    return version;
  });
}

export function currentVersion(db, ideaId) {
  return db.get(`SELECT v.* FROM idea_versions v JOIN ideas i ON i.id = v.idea_id AND i.current_version = v.version
                 WHERE v.idea_id = ?`, ideaId);
}

export function publishIdea(db, ideaId, wallet, publish) {
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
  if (!idea || idea.owner_wallet !== wallet) throw new HttpError(404, 'not_found');
  if (!publish && ['approved', 'launch_prepared', 'awaiting_signature', 'confirming', 'launched', 'failed'].includes(idea.status)) {
    throw new HttpError(409, 'locked', 'a launched or launching project stays public');
  }
  db.run('UPDATE ideas SET visibility = ?, published_at = ?, updated_at = ? WHERE id = ?',
    publish ? 'public' : 'private', publish ? now() : null, now(), ideaId);
  audit(db, { actor: `wallet:${wallet}`, kind: 'visibility', ideaId, message: publish ? 'Made public by the submitter' : 'Made private by the submitter', isPublic: publish });
}

/** What a viewer may see. Owners and admins see everything; others only published ideas, and never private fields. */
export function viewIdea(db, ideaId, viewer) {
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
  if (!idea) return null;
  const owner = viewer && viewer.wallet === idea.owner_wallet;
  const admin = viewer && (viewer.role === 'admin' || viewer.role === 'reviewer');
  if (idea.visibility !== 'public' && !owner && !admin) return null;
  const v = currentVersion(db, ideaId);
  const versions = (owner || admin)
    ? db.all('SELECT version, title, receiving_wallet, created_at, content_hash FROM idea_versions WHERE idea_id = ? ORDER BY version', ideaId)
    : undefined;
  const timeline = db.all(`SELECT at, actor, kind, message, data_json FROM events WHERE idea_id = ? ${owner || admin ? '' : 'AND public = 1'}
                           ORDER BY at, id`, ideaId).map((e) => ({ ...e, data: parseJson(e.data_json), data_json: undefined,
    actor: e.actor.startsWith('wallet:') || e.actor.startsWith('admin:') ? e.actor.split(':')[0] : e.actor }));
  const evaluation = db.get('SELECT * FROM evaluations WHERE idea_id = ? ORDER BY created_at DESC LIMIT 1', ideaId);
  const uploads = db.all('SELECT id, mime, bytes FROM uploads WHERE idea_id = ?', ideaId);
  const project = db.get('SELECT p.id, p.slug, p.name, p.ticker, l.provider, l.network FROM projects p LEFT JOIN launches l ON l.project_id = p.id WHERE p.idea_id = ?', ideaId);
  const ledger = evaluation && (owner || admin || idea.status !== 'declined')
    ? db.get('SELECT seq, hash FROM vote_ledger WHERE request_id = ?', evaluation.brain_request_id) || null : null;
  const job = db.get(`SELECT type, status, attempts, max_attempts, run_after, progress, last_error FROM jobs
                      WHERE idea_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, ideaId);
  return {
    id: idea.id, status: idea.status, statusNote: idea.status_note, visibility: idea.visibility,
    publishedAt: idea.published_at, createdAt: idea.created_at, owner: Boolean(owner), canAdmin: Boolean(admin),
    submittedBy: idea.owner_wallet,
    version: idea.current_version,
    title: v.title, concept: v.concept, nameSuggestion: v.name_suggestion, tickerSuggestion: v.ticker_suggestion,
    links: parseJson(v.links_json, []), contacts: parseJson(v.contacts_json, {}), receivingWallet: v.receiving_wallet,
    uploads, versions, timeline, project, pinnedHash: idea.pinned_hash ?? null, pinnedAt: idea.pinned_at ?? null, ledgerSeq: ledger?.seq ?? null,
    evaluation: evaluation && { decision: evaluation.decision, decidedBy: evaluation.decided_by,
      scores: parseJson(evaluation.scores_json), brain: parseJson(evaluation.brain_json), at: evaluation.created_at,
      version: evaluation.idea_version, // the vote-ledger row; a passed idea is not linked to it publicly (GET /api/votes shows no titles for those)
      ledger },
    job: job && { type: job.type, status: job.status, attempts: job.attempts, maxAttempts: job.max_attempts,
      runAfter: job.run_after, progress: job.progress, lastError: (owner || admin) ? job.last_error : undefined },
  };
}

export function readUpload(db, cfg, uploadId, viewer) {
  const u = db.get('SELECT u.*, i.visibility, i.owner_wallet FROM uploads u JOIN ideas i ON i.id = u.idea_id WHERE u.id = ?', uploadId);
  if (!u) return null;
  const allowed = u.visibility === 'public' || (viewer && (viewer.wallet === u.owner_wallet || viewer.role === 'admin' || viewer.role === 'reviewer'));
  if (!allowed) return null;
  return { mime: u.mime, body: readFileSync(uploadPath(cfg.dataDir, u.sha256, u.mime)) };
}
