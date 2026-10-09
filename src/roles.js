// Community roles and takeovers. The founder (the submitter, at first) names community leads and moderators. After
// launch a community member can ask to take over the founder role; the founder decides, or an admin when the founder
// has been silent for 30 days. A takeover NEVER changes who receives creator fees: they are locked on-chain at creation.
import { audit } from './db.js';
import { shortWallet } from './world.js';
import { id, now, HttpError, parseJson, isSolanaAddress } from './util.js';

export const INACTIVE_MS = 30 * 86_400_000;
const GRANTABLE = ['community_lead', 'moderator'];

export const founderOf = (db, projectId) => db.get(`SELECT * FROM project_roles WHERE project_id = ? AND role = 'founder'`, projectId);

/** The fee recipients as locked at launch (or as approved, before it). Full wallets: they are public on-chain. */
export function feeRecipients(db, projectId) {
  const launch = db.get('SELECT intent_id FROM launches WHERE project_id = ?', projectId);
  const config = launch && parseJson(db.get('SELECT config_json FROM launch_intents WHERE id = ?', launch.intent_id)?.config_json);
  return (config?.feeSharing?.recipients || []).map(({ label, role, wallet, bps }) => ({ label, role, wallet, bps }));
}

export function feeNotice(db, projectId) {
  const recipients = feeRecipients(db, projectId);
  const list = recipients.map((r) => `${r.label} ${(r.bps / 100).toFixed(2)}% → ${r.wallet}`).join('; ');
  return { feeRecipients: recipients,
    feeNote: `A takeover never changes fee recipients: they were locked on-chain when the token was created. Creator fees keep going to: ${list || 'the recipients locked at launch'}.` };
}

/** Last audited activity of a wallet (any event it authored), or when it got the founder role if later. */
export function lastActivity(db, wallet, projectId) {
  const e = db.get('SELECT MAX(at) at FROM events WHERE actor = ?', `wallet:${wallet}`)?.at || 0;
  const g = db.get('SELECT granted_at FROM project_roles WHERE project_id = ? AND wallet = ?', projectId, wallet)?.granted_at || 0;
  return Math.max(e, g);
}

export function rolesView(db, project, viewer) {
  const roles = db.all('SELECT wallet, role, granted_at FROM project_roles WHERE project_id = ? ORDER BY granted_at', project.id);
  const open = db.get(`SELECT * FROM takeover_requests WHERE project_id = ? AND status = 'open'`, project.id);
  return {
    roles: roles.map((r) => ({ wallet: shortWallet(r.wallet), role: r.role, grantedAt: r.granted_at })),
    you: viewer ? roles.find((r) => r.wallet === viewer.wallet)?.role ?? null : null,
    openTakeover: open && { id: open.id, requester: shortWallet(open.requester), reason: open.reason, createdAt: open.created_at },
    ...feeNotice(db, project.id),
  };
}

/** Founder only: grant (role) or revoke (role null) a community role. */
export function setRole(db, project, actor, { wallet, role }) {
  const f = founderOf(db, project.id);
  if (!f || f.wallet !== actor) throw new HttpError(403, 'not_founder', 'only the founder manages roles');
  if (!isSolanaAddress(wallet)) throw new HttpError(400, 'bad_wallet');
  if (wallet === actor) throw new HttpError(400, 'bad_wallet', 'the founder role moves only through a takeover');
  if (role != null && !GRANTABLE.includes(role)) throw new HttpError(400, 'bad_role', `one of ${GRANTABLE.join(', ')}, or null to revoke`);
  db.tx(() => {
    if (role == null) {
      const r = db.run(`DELETE FROM project_roles WHERE project_id = ? AND wallet = ? AND role != 'founder'`, project.id, wallet);
      if (!r.changes) throw new HttpError(404, 'no_role');
    } else {
      db.run(`INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(project_id, wallet) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
      project.id, wallet, role, actor, now());
    }
    audit(db, { actor: `wallet:${actor}`, kind: 'role', projectId: project.id, ideaId: project.idea_id, isPublic: true,
      message: role == null ? `Founder removed the community role of ${shortWallet(wallet)}` : `Founder named ${shortWallet(wallet)} ${role.replace('_', ' ')}` });
  });
}

export function requestTakeover(db, project, requester, reason) {
  if (!db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id)) throw new HttpError(409, 'not_launched', 'takeovers are for launched projects');
  const f = founderOf(db, project.id);
  if (f?.wallet === requester) throw new HttpError(409, 'already_founder');
  const text = String(reason ?? '').replace(/[\u0000-\u001F\u007F<>`]/g, ' ').trim();
  if (!text || text.length > 500) throw new HttpError(400, 'bad_reason', '1–500 characters');
  const tid = id('tko');
  db.tx(() => {
    if (db.get(`SELECT 1 FROM takeover_requests WHERE project_id = ? AND status = 'open'`, project.id)) throw new HttpError(409, 'takeover_open', 'a takeover request is already open for this project');
    db.run(`INSERT INTO takeover_requests (id, project_id, requester, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`, tid, project.id, requester, text, now());
    audit(db, { actor: `wallet:${requester}`, kind: 'takeover', projectId: project.id, ideaId: project.idea_id, isPublic: true,
      message: `Community takeover requested by ${shortWallet(requester)}` });
  });
  return { id: tid, status: 'open', ...feeNotice(db, project.id) };
}

/** Founder decides; an admin may decide only when the founder has had no audited activity for 30 days. */
export function decideTakeover(db, takeoverId, user, approve, t = now()) {
  const req = db.get('SELECT * FROM takeover_requests WHERE id = ?', takeoverId);
  if (!req) throw new HttpError(404, 'not_found');
  if (req.status !== 'open') throw new HttpError(409, 'not_open', `request is ${req.status}`);
  const project = db.get('SELECT * FROM projects WHERE id = ?', req.project_id);
  const f = founderOf(db, project.id);
  let actor;
  if (f && f.wallet === user.wallet) actor = `wallet:${user.wallet}`;
  else if (user.role === 'admin') {
    if (f && t - lastActivity(db, f.wallet, project.id) < INACTIVE_MS) {
      throw new HttpError(403, 'founder_active', 'the founder was active in the last 30 days: only the founder can decide');
    }
    actor = `admin:${user.wallet}`;
  } else throw new HttpError(403, 'forbidden', 'only the founder can decide');
  db.tx(() => {
    const r = db.run(`UPDATE takeover_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`,
      approve ? 'approved' : 'rejected', actor, t, req.id);
    if (r.changes !== 1) throw new HttpError(409, 'not_open');
    if (approve) {
      // the old founder keeps no role; the requester's previous role (if any) becomes founder
      if (f) db.run('DELETE FROM project_roles WHERE project_id = ? AND wallet = ?', project.id, f.wallet);
      db.run('DELETE FROM project_roles WHERE project_id = ? AND wallet = ?', project.id, req.requester);
      db.run(`INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at) VALUES (?, ?, 'founder', ?, ?)`, project.id, req.requester, actor, t);
    }
    audit(db, { actor, kind: 'takeover', projectId: project.id, ideaId: project.idea_id, isPublic: true,
      message: approve
        ? `Community takeover approved${actor.startsWith('admin:') ? ' by a SUBZERONE admin (founder inactive 30 days)' : ' by the founder'}: founder role moved from ${f ? shortWallet(f.wallet) : 'nobody'} to ${shortWallet(req.requester)}. Fee recipients unchanged (locked on-chain).`
        : `Community takeover request by ${shortWallet(req.requester)} rejected`,
      data: { takeover: req.id, feeRecipients: feeRecipients(db, project.id) } });
  });
  return { id: req.id, status: approve ? 'approved' : 'rejected', founder: shortWallet(approve ? req.requester : f?.wallet), ...feeNotice(db, project.id) };
}

export function withdrawTakeover(db, takeoverId, wallet) {
  const req = db.get('SELECT * FROM takeover_requests WHERE id = ?', takeoverId);
  if (!req || req.requester !== wallet) throw new HttpError(404, 'not_found');
  const r = db.run(`UPDATE takeover_requests SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`, `wallet:${wallet}`, now(), req.id);
  if (r.changes !== 1) throw new HttpError(409, 'not_open');
  return { id: req.id, status: 'withdrawn', ...feeNotice(db, req.project_id) };
}
