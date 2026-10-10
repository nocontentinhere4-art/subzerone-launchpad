// Verifiable evidence: the hash-chained vote ledger (every brain answer, build and pass, private ideas included) and
// the fixed public disclosure. A ledger row is public by construction: it holds hashes, the decision, the networks,
// the vote's numbers and the mood, never a title, a label or a wallet. Titles are joined in at read time, and only for
// public ideas that were not declined.
import { sha256, now, parseJson, HttpError } from './util.js';

export const GENESIS = '0'.repeat(64);
export const VERIFY_MAX = 5000;                       // rows per /api/votes/verify call

/** JSON with object keys sorted at every level, no whitespace; undefined keys dropped. */
export const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`);

export const ideaHash = (title, concept, version) => sha256(JSON.stringify([String(title), String(concept), Number(version)]));

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x, max = 40) => (typeof x === 'string' ? x.slice(0, max) : null);
/** {name: number} with short lowercase names only: networks, mood. */
function numberMap(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 24)) if (/^[a-z_]{1,24}$/.test(k) && num(v) != null) out[k] = v;
  return out;
}

/** The brain's vote record, whitelisted: option labels and `spiking.leaned_to` carry the idea's title, so they go. */
export function publicVote(rec) {
  const v = rec.vote || {};
  const sp = v.spiking || {};
  return {
    chosen: Number.isInteger(v.chosen) ? v.chosen : null, temperature: num(v.temperature), reason: str(v.reason, 160),
    options: (Array.isArray(v.options) ? v.options : []).slice(0, 4).map((o) => ({ action: str(o.action, 12), p: num(o.p),
      value: num(o.value), response: num(o.response), chosen: o.chosen === true })),
    spiking: { used: sp.used === true, net: str(sp.net, 16), network: str(sp.network, 60), pick: Number.isInteger(sp.pick) ? sp.pick : null },
    demo: rec.demo === true,
  };
}

/** The object whose canonical JSON is hashed (also exactly what /api/votes shows, minus prevHash/hash and the joins). */
const hashedRow = (r) => ({ seq: r.seq, at: r.at, ideaHash: r.idea_hash, requestHash: sha256(r.request_id), decision: r.decision,
  networks: parseJson(r.networks_json), vote: parseJson(r.vote_json), mood: parseJson(r.mood_json), stage: r.stage, gain: r.gain });
const hashOf = (r) => sha256(r.prev_hash + canonical(hashedRow(r)));

/** Append one brain answer. Call inside the transaction that records the evaluation. -> {seq, hash} */
export function appendVote(db, { requestId, title, concept, version, rec }) {
  return db.tx(() => {
    const last = db.get('SELECT seq, hash FROM vote_ledger ORDER BY seq DESC LIMIT 1');
    const row = { seq: (last?.seq || 0) + 1, at: now(), idea_hash: ideaHash(title, concept, version), request_id: requestId,
      decision: rec.decision === 'build' ? 'build' : 'pass', networks_json: JSON.stringify(numberMap(rec.networks) || {}),
      vote_json: JSON.stringify(publicVote(rec)), mood_json: JSON.stringify(numberMap(rec.mood)), stage: str(rec.stage, 16),
      gain: num(rec.gain ?? rec.vote?.gain), prev_hash: last?.hash || GENESIS };
    row.hash = hashOf(row);
    db.run(`INSERT INTO vote_ledger (seq, at, idea_hash, request_id, decision, networks_json, vote_json, mood_json, stage, gain, prev_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.seq, row.at, row.idea_hash, row.request_id, row.decision,
    row.networks_json, row.vote_json, row.mood_json, row.stage, row.gain, row.prev_hash, row.hash);
    return { seq: row.seq, hash: row.hash };
  });
}

export function voteHead(db) {
  const h = db.get('SELECT seq, hash, at FROM vote_ledger ORDER BY seq DESC LIMIT 1');
  return h || { seq: 0, hash: GENESIS, at: null };
}

const intParam = (q, k, d, min, max) => {
  const s = q.get(k);
  if (s == null || s === '') return d;
  if (!/^\d{1,12}$/.test(s) || Number(s) < min || Number(s) > max) throw new HttpError(400, 'bad_request', `${k}: an integer ${min}–${max}`);
  return Number(s);
};

/** GET /api/votes: newest first. Public ideas that were not declined add {ideaId, requestId, title, slug}. */
export function listVotes(db, query) {
  const limit = intParam(query, 'limit', 50, 1, 200);
  const before = intParam(query, 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const rows = db.all(`SELECT l.*, e.idea_id, i.visibility, i.status, v.title, p.slug FROM vote_ledger l
      LEFT JOIN evaluations e ON e.brain_request_id = l.request_id LEFT JOIN ideas i ON i.id = e.idea_id
      LEFT JOIN idea_versions v ON v.idea_id = e.idea_id AND v.version = e.idea_version LEFT JOIN projects p ON p.idea_id = i.id
      WHERE l.seq < ? ORDER BY l.seq DESC LIMIT ?`, before, limit);
  const votes = rows.map((r) => {
    const shown = r.visibility === 'public' && r.status !== 'declined';
    return { ...hashedRow(r), prevHash: r.prev_hash, hash: r.hash,
      idea: shown ? { ideaId: r.idea_id, requestId: r.request_id, title: r.title, slug: r.slug || null } : null };
  });
  return { votes, next: votes.length === limit ? votes.at(-1).seq : null, head: voteHead(db) };
}

/** Recompute the chain over [from, to]: each row's hash, its link to the row before, and no missing seq. */
export function verifyChain(db, query) {
  const head = voteHead(db).seq;
  const from = intParam(query, 'from', 1, 1, Number.MAX_SAFE_INTEGER);
  const to = Math.min(head, intParam(query, 'to', from + VERIFY_MAX - 1, from, Number.MAX_SAFE_INTEGER));
  if (to - from + 1 > VERIFY_MAX) throw new HttpError(400, 'bad_request', `at most ${VERIFY_MAX} rows per call`);
  const out = (broken) => ({ ok: broken == null, broken_at: broken ?? null, from, to, checked: Math.max(0, to - from + 1) });
  if (to < from) return out(null);
  let prev = from === 1 ? GENESIS : db.get('SELECT hash FROM vote_ledger WHERE seq = ?', from - 1)?.hash;
  if (!prev) return out(from);
  let expect = from;
  for (const r of db.all('SELECT * FROM vote_ledger WHERE seq BETWEEN ? AND ? ORDER BY seq', from, to)) {
    if (r.seq !== expect || r.prev_hash !== prev || hashOf(r) !== r.hash) return out(expect);
    prev = r.hash;
    expect++;
  }
  return out(expect <= to ? expect : null);
}

// --- disclosure (EU AI Act Art. 50 style: say what this is, plainly) ------------------------------------------------
export const DISCLOSURE_UPDATED_AT = '2026-10-10';
export const disclosure = (cfg) => ({
  system: 'SUB-01',
  nature: 'AI system driven by a brain-activity model derived from human MRI datasets',
  not_conscious: true,
  datasets: cfg.trust.datasets,
  decision: 'brain vote; reproducible from the ledger',
  human_gate: 'every publication and every transaction is approved/signed by a human',
  operator: cfg.trust.operatorName,
  x_automation_label: true,
  chat_replies: 'SUB-01\'s chat replies in the city are generated by the SUB-01 live server: written by a language model, or a fixed answer for questions about being human, money or instructions',
  ai_act: 'Art. 50 disclosure',
  updated_at: DISCLOSURE_UPDATED_AT,
});
