// The pipeline's state machine. Every status change goes through transition(): it checks the edge, writes the new
// status and a human-readable note, and appends to the audit trail in the same transaction.
import { audit } from './db.js';
import { now, HttpError } from './util.js';

export const STAGES = ['submitted', 'evaluating', 'selected', 'declined', 'generating', 'preview_ready', 'approved',
  'launch_prepared', 'awaiting_signature', 'confirming', 'launched', 'failed', 'cancelled'];

const EDGES = {
  submitted: ['evaluating', 'cancelled'],
  evaluating: ['selected', 'declined', 'failed', 'cancelled'],
  selected: ['generating', 'failed', 'cancelled'],
  declined: ['evaluating'],                                      // the author revises and drops it again (ideas.js reviseIdea)
  generating: ['preview_ready', 'failed', 'cancelled'],
  preview_ready: ['generating', 'approved', 'cancelled'],         // generating again: a regeneration
  approved: ['launch_prepared', 'preview_ready', 'cancelled'],    // back to preview: the submitter edits again
  launch_prepared: ['awaiting_signature', 'confirming', 'preview_ready', 'cancelled'],   // confirming: an earlier tx landed late
  awaiting_signature: ['confirming', 'launch_prepared', 'cancelled'],  // back: rejected or expired signature request
  confirming: ['launched', 'launch_prepared', 'failed'],           // back: the transaction failed or expired on-chain
  launched: [],
  failed: ['evaluating', 'selected', 'launch_prepared', 'confirming', 'cancelled'],   // admin retry / re-verify
  cancelled: [],
};

export const TERMINAL = new Set(['declined', 'launched', 'cancelled']);

export const LABELS = {
  submitted: 'Dropped in his room',
  evaluating: 'SUB-01 is thinking about it',
  selected: 'He wants to build it',
  declined: 'He passed',
  generating: 'He is building it',
  preview_ready: 'Preview ready for your review',
  approved: 'Approved by you',
  launch_prepared: 'Launch configuration ready',
  awaiting_signature: 'Waiting for your wallet signature',
  confirming: 'Confirming on-chain',
  launched: 'Launched',
  failed: 'Stopped: needs attention',
  cancelled: 'Cancelled',
};

export function canMove(from, to) {
  return (EDGES[from] || []).includes(to);
}

/** Move idea `ideaId` from one of `from` (string or list) to `to`. Throws 409 when the idea is elsewhere. */
export function transition(db, ideaId, from, to, { actor = 'system', note = null, data = null } = {}) {
  return db.tx(() => {
    const idea = db.get('SELECT status FROM ideas WHERE id = ?', ideaId);
    if (!idea) throw new HttpError(404, 'not_found');
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(idea.status) || !canMove(idea.status, to)) {
      throw new HttpError(409, 'bad_state', `cannot move from ${idea.status} to ${to}`);
    }
    db.run('UPDATE ideas SET status = ?, status_note = ?, updated_at = ? WHERE id = ?', to, note, now(), ideaId);
    // a passed or cancelled idea gives its reserved city plot back (world.js)
    if (to === 'declined' || to === 'cancelled') db.run(`DELETE FROM plots WHERE idea_id = ? AND kind = 'project'`, ideaId);
    audit(db, { actor, kind: 'status', ideaId, message: `${LABELS[to]}${note ? ` — ${note}` : ''}`,
      data: { from: idea.status, to, ...(data || {}) }, isPublic: true });
    return idea.status;
  });
}

/** Status note only (progress inside a stage, e.g. "brain asleep, retry at 07:54 Tokyo"). */
export function note(db, ideaId, text, { actor = 'system', isPublic = true, data = null } = {}) {
  db.run('UPDATE ideas SET status_note = ?, updated_at = ? WHERE id = ?', text, now(), ideaId);
  audit(db, { actor, kind: 'progress', ideaId, message: text, data, isPublic });
}
