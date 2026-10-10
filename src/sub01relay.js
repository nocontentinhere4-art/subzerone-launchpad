// One shared WebSocket from this process to the SUB-01 live server (sub01-main/live_server.py, `ws_handler`), so the
// city can talk to him. The relay only carries what the live server says: his state comes from its tick payloads
// (sleep.stage, life.activity / life.walking) and GET /api/mind (status.resting = over the daily AI cap); his
// replies are its `chat_reply` broadcasts, passed on as they are. When the socket is down his state is 'offline' and
// nothing is said in his name. Nothing here writes a reply.
//
// The live server's viewer message is {type: 'chat', text} (ws_handler reads only `type` and `text`; its own filter,
// 1 message / 10 s per client address and a duplicate check run there, and it answers chat_ack {ok, reason}). A
// `nick` (clean_nick rules) is sent alongside for display; today's live server ignores it for chat.
//
// `connect(url)` returns a transport {send(string), close()} whose onopen / onmessage(string) / onclose the relay
// sets; the default wraps Node's global WebSocket. Tests pass a fake.

export const RELAY = { backoffMinMs: 1000, backoffMaxMs: 60_000, ackMs: 8000, staleMs: 45_000, mindEveryMs: 60_000,
  inboxMs: 1_800_000, inboxMax: 10, nickMax: 16 };

/** The live server's lite feed at 1 tick a second (no per-region activity): all the relay reads. */
export function wsUrl(base) {
  const u = new URL('/ws', base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = 'lite=1&rate=1';
  return u.toString();
}

export function wsConnect(url) {
  const ws = new WebSocket(url);
  const t = { send: (s) => ws.send(s), close: () => { try { ws.close(); } catch { /* already closed */ } } };
  ws.onopen = () => t.onopen?.();
  ws.onmessage = (e) => t.onmessage?.(typeof e.data === 'string' ? e.data : '');
  ws.onclose = () => t.onclose?.();
  ws.onerror = () => {};                                    // a close event follows
  return t;
}

/** chat.py dedupe_key: lowercase letters and digits only. */
export const textKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** chat.py clean_nick: whitespace collapsed, at most 16 characters, else no nickname. (Its `blocked` filter runs on
 * the live server; resident names are already letters, digits, spaces and . _ ' -.) */
export function cleanNick(nick) {
  const n = String(nick ?? '').replace(/\s+/g, ' ').trim();
  return n.length > RELAY.nickMax ? '' : n;
}

export function createRelay({ url, connect = wsConnect, fetchMind = null, onState = () => {}, onReply = () => {},
  clock = Date.now, opts = {} } = {}) {
  const o = { ...RELAY, ...opts };
  let t = null, open = false, stopped = true, attempt = 0, retry = null, watch = null, mindTimer = null;
  let stage = null, activity = null, walking = false, resting = false, lastMsgAt = 0, last = '';
  const acks = [];                                          // FIFO: the live server acks one socket's chats in order
  let pending = [];                                         // city messages he heard and has not answered: {id, name, text, key, at}
  const seen = [];                                          // recent chat_reply keys (no double relay)

  function state() {
    const now = clock();
    if (!open || !stage || now - lastMsgAt > o.staleMs) return { state: 'offline', atDesk: false, waiting: 0 };
    if (stage !== 'AWAKE') return { state: 'asleep', atDesk: false, waiting: 0 };
    const atDesk = activity === 'chat' && !walking;
    // as the live server's life.chat_waiting: 0 unless awake and under the cap; only city messages are counted here
    pending = pending.filter((p) => now - p.at < o.inboxMs);
    if (resting) return { state: 'resting', atDesk, waiting: 0 };
    return { state: 'awake', atDesk, waiting: Math.min(o.inboxMax, pending.length) };
  }
  const emit = () => { const s = state(), j = JSON.stringify(s); if (j !== last) { last = j; onState(s); } };

  async function pollMind() {
    if (!fetchMind || !open) return;
    try {
      const j = await fetchMind();
      if (j && typeof j === 'object' && j.status && typeof j.status.resting === 'boolean') resting = j.status.resting;
    } catch { /* keep the last known value */ }
    emit();
  }

  function onMessage(raw) {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== 'object') return;
    lastMsgAt = clock();
    attempt = 0;
    if (d.type === 'tick') {
      if (typeof d.sleep?.stage === 'string') stage = d.sleep.stage;
      if (d.life && typeof d.life === 'object') { activity = typeof d.life.activity === 'string' ? d.life.activity : null; walking = Boolean(d.life.walking ?? d.life.path); }
    } else if (d.type === 'chat_ack') {
      const w = acks.shift();
      if (w && !w.done) { w.done = true; clearTimeout(w.timer); w.resolve({ ok: d.ok === true, reason: d.ok === true ? null : String(d.reason || 'refused').slice(0, 120) }); }
    } else if (d.type === 'chat') {
      if (typeof d.stage === 'string') stage = d.stage;    // the echo of a message carries his stage when he heard it
    } else if (d.type === 'chat_reply' && typeof d.text === 'string' && d.text.trim()) {
      const k = `${d.t}|${d.text}`;
      if (!seen.includes(k)) {
        seen.push(k);
        if (seen.length > 50) seen.shift();
        const said = typeof d.replying_to === 'string' ? d.replying_to : '';
        const i = said ? pending.findIndex((p) => p.key === textKey(said)) : -1;
        const mine = i >= 0 ? pending.splice(i, 1)[0] : null;
        onReply({ text: d.text, replyingTo: { id: mine?.id ?? null, name: mine?.name ?? null, text: mine?.text ?? said } });
      }
    } else if (d.type === 'full') {
      t?.close();
    }
    emit();
  }

  function dropped(tr) {
    if (tr !== t) return;                                   // an old socket's late close
    t = null; open = false;
    for (const w of acks.splice(0)) if (!w.done) { w.done = true; clearTimeout(w.timer); w.resolve({ ok: false, reason: 'connection lost', lost: true }); }
    clearInterval(mindTimer);
    emit();
    if (stopped) return;
    const delay = Math.min(o.backoffMaxMs, o.backoffMinMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt++;
    retry = setTimeout(dial, delay);
    retry.unref?.();
  }

  function dial() {
    retry = null;
    if (stopped || t) return;
    let tr;
    try { tr = connect(url); } catch { t = {}; return dropped(t); }
    t = tr;
    tr.onopen = () => {
      if (tr !== t) return;
      open = true;
      lastMsgAt = clock();
      clearInterval(mindTimer);
      mindTimer = setInterval(pollMind, o.mindEveryMs);
      mindTimer.unref?.();
      pollMind();
      emit();
    };
    tr.onmessage = (raw) => { if (tr === t) onMessage(raw); };
    tr.onclose = () => dropped(tr);
  }

  return {
    get configured() { return Boolean(url); },
    get open() { return open; },
    state,
    start() {
      if (!url || !stopped) return;
      stopped = false;
      watch = setInterval(() => {                           // a socket that went quiet is dead: drop it and redial
        if (open && clock() - lastMsgAt > o.staleMs) { const tr = t; tr?.close(); dropped(tr); }
        emit();
      }, Math.min(15_000, o.staleMs / 3));
      watch.unref?.();
      dial();
    },
    stop() {
      stopped = true;
      clearTimeout(retry); clearInterval(watch); clearInterval(mindTimer);
      const tr = t;
      tr?.close?.();
      dropped(tr);
    },
    /** -> {ok, reason, timeout?, lost?}: the live server's chat_ack for this message. */
    send(text, nick) {
      if (!open || !t) return Promise.resolve({ ok: false, reason: 'offline', lost: true });
      return new Promise((resolve) => {
        const w = { resolve, done: false };
        w.timer = setTimeout(() => { if (!w.done) { w.done = true; resolve({ ok: false, reason: 'no answer', timeout: true }); } }, o.ackMs);
        acks.push(w);                                       // stays queued after a timeout so a late ack lines up
        const n = cleanNick(nick);
        try { t.send(JSON.stringify({ type: 'chat', text, ...(n ? { nick: n } : {}) })); } catch {
          acks.splice(acks.indexOf(w), 1); w.done = true; clearTimeout(w.timer); resolve({ ok: false, reason: 'connection lost', lost: true });
        }
      });
    },
    /** A city message he accepted: his reply to it (if any) is matched by text, and it counts as waiting. */
    track({ id, name, text }) {
      pending.push({ id, name, text, key: textKey(text), at: clock() });
      if (pending.length > 50) pending.shift();
      emit();
    },
  };
}
