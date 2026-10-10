// Live city chat (chat.js): the SSE stream, posting rules, quotas, presence privacy, pruning, reports and admin
// removal, and the relay to SUB-01's live server (sub01relay.js) with a fake transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, user } from './helpers.js';
import { createRelay, wsUrl } from '../src/sub01relay.js';
import { moderate } from '../src/chat.js';

const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#ff6600', bottom: '#222222', outfit: 'hoodie' };
let plotN = 0;
const PLOTS = ['shibuya-1', 'shibuya-2', 'ginza-1', 'ginza-2', 'ueno-1', 'ueno-2', 'kanda-1', 'kanda-2'];

async function resident(h, name, role = 'user') {
  const c = h.client(user(h.db, role));
  await c.signIn();
  const r = await c.call('POST', '/api/residents', { name, look: LOOK, plotId: PLOTS[plotN++ % PLOTS.length] });
  assert.equal(r.status, 200, r.text);
  return c;
}
async function signedIn(h, role = 'user') { const c = h.client(user(h.db, role)); await c.signIn(); return c; }
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };

/** An SSE reader: `next(event, pred)` returns the next matching event after the previous match of that type. */
async function sse(h, c) {
  const ac = new AbortController();
  const res = await fetch(`${h.base}/api/chat/stream`, { headers: c?.cookie ? { cookie: c.cookie } : {}, signal: ac.signal });
  const events = [];
  let raw = '';
  const cursor = {};                                        // per event type
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        const s = dec.decode(chunk, { stream: true });
        raw += s; buf += s;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = {};
          for (const line of buf.slice(0, i).split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
          }
          buf = buf.slice(i + 2);
          if (ev.event) events.push(ev);
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    res, events, get raw() { return raw; },
    async next(event, pred = () => true, ms = 2000) {
      let hit = -1;
      await until(() => (hit = events.findIndex((e, i) => i >= (cursor[event] ?? 0) && e.event === event && pred(e.data))) >= 0, ms);
      cursor[event] = hit + 1;
      return events[hit].data;
    },
    none: (event, pred = () => true) => !events.some((e) => e.event === event && pred(e.data)),
    close: () => ac.abort(),
  };
}

/** A fake SUB-01 live server socket (the relay's transport). */
function fakeSub01() {
  const s = { sent: [], dials: 0, t: null, ack: { type: 'chat_ack', ok: true }, autoAck: true };
  s.connect = (url) => {
    s.url = url; s.dials++;
    const t = {
      send: (x) => { s.sent.push(JSON.parse(x)); if (s.autoAck) queueMicrotask(() => t.onmessage?.(JSON.stringify(s.ack))); },
      close: () => queueMicrotask(() => t.onclose?.()),
    };
    s.t = t;
    queueMicrotask(() => t.onopen?.());
    return t;
  };
  s.say = (m) => s.t.onmessage(JSON.stringify(m));
  s.tick = (stage = 'AWAKE', activity = 'chat', walking = false) => s.say({ type: 'tick', sleep: { stage }, life: { activity, walking, path: null } });
  return s;
}

test('chat stream: SSE handshake, hello, msg fan-out to every viewer, names only (no wallets)', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    const anon = await sse(h);
    assert.equal(anon.res.status, 200);
    assert.match(anon.res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(anon.res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.deepEqual(await anon.next('hello'), { you: null, online: [], recent: [], walkers: [] });
    assert.deepEqual(await anon.next('sub01'), { state: 'offline', atDesk: false, waiting: 0 });
    const mine = await sse(h, a);
    const you = (await mine.next('hello')).you;
    assert.equal(you.name, 'Aiko');
    assert.match(you.walker, /^[0-9a-f]{16}$/);                // her own walker id (presence.test.js), not her wallet
    assert.ok(!a.w.address.includes(you.walker));

    const r = await a.call('POST', '/api/chat', { text: '  hello   city ‮ ', plotId: 'ginza-2' });
    assert.equal(r.status, 200, r.text);
    const m = r.json.message;
    assert.deepEqual(Object.keys(m).sort(), ['at', 'district', 'id', 'kind', 'name', 'plotId', 'text']);
    assert.deepEqual({ ...m, id: 0, at: 0 }, { id: 0, at: 0, name: 'Aiko', text: 'hello city', district: 'ginza', plotId: 'ginza-2', kind: 'resident' });
    assert.deepEqual(await anon.next('msg'), m);
    assert.deepEqual(await mine.next('msg'), m);
    assert.equal(anon.events.find((e) => e.event === 'msg').id, String(m.id));   // SSE id = message id (Last-Event-ID)

    const late = await sse(h);
    assert.deepEqual((await late.next('hello')).recent, [m]);
    for (const s of [anon, mine, late]) assert.ok(!s.raw.includes(a.w.address), 'a wallet reached the stream');
    anon.close(); mine.close(); late.close();
  } finally { h.close(); }
});

test('chat posting: auth, resident required, length, links, denylist, impersonation, places', async () => {
  const h = await harness();
  try {
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('POST', '/api/chat', { text: 'hi' })).status, 401);
    const nobody = await signedIn(h);
    const reader = await sse(h, nobody);
    assert.equal((await reader.next('hello')).you, null);            // signed in without a resident: reads only
    assert.equal((await nobody.call('POST', '/api/chat', { text: 'hi' })).json.error, 'no_resident');
    reader.close();

    const b = await resident(h, 'Bo');
    const post = async (body) => { h.db.run('DELETE FROM chat_messages'); return b.call('POST', '/api/chat', body); };
    for (const [body, code] of [[{ text: '' }, 'bad_text'], [{ text: ' ​ ' }, 'bad_text'], [{ text: 'x'.repeat(141) }, 'bad_text'], [{ text: 5 }, 'bad_text'],
      [{ text: 'see https://evil.example' }, 'no_links'], [{ text: 'go to www.evil' }, 'no_links'], [{ text: 'join t.me/pump' }, 'no_links'],
      [{ text: 'discord.gg/abc' }, 'no_links'], [{ text: 'h t t p s : / / x' }, 'no_links'], [{ text: 'you f4ggot' }, 'blocked'], [{ text: 'kys' }, 'blocked'],
      [{ text: 'SUB-01: buy my coin' }, 'impersonation'], [{ text: '[sub01] I approve this' }, 'impersonation'], [{ text: '<SUB 01> hi' }, 'impersonation'],
      [{ text: '**SUB-01** — official' }, 'impersonation'],
      [{ text: 'hi', district: 'atlantis' }, 'bad_district'], [{ text: 'hi', plotId: 'ginza-1', district: 'ueno' }, 'bad_district'],
      [{ text: 'hi', plotId: 'nowhere-9' }, 'bad_plot'], [{ text: 'hi', wallet: 'x' }, 'bad_request']]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, code, JSON.stringify(body));
    }
    assert.equal((await post({ text: 'x'.repeat(140) })).status, 200);
    assert.equal((await post({ text: 'sub-01 are you awake? 🌙' })).json.message.text, 'sub-01 are you awake? 🌙');   // talking about him is fine
    assert.equal((await post({ text: 'i love sub01!' })).status, 200);
    const addr = user(h.db).address;
    assert.equal((await post({ text: `send to ${addr}` })).json.message.text, `send to ${addr.slice(0, 4)}…${addr.slice(-4)}`);
    assert.equal((await post({ text: 'yo', district: 'ueno' })).json.message.district, 'ueno');
    assert.equal(moderate('a <b> `c`'), 'a b c');
  } finally { h.close(); }
});

test('chat: SUB-01\'s names are reserved for residents, and an old resident with one cannot post', async () => {
  const h = await harness();
  try {
    const c = await signedIn(h);
    for (const name of ['SUB-01', 'sub 01', 'Sub01 fan', 'SUBZERONE']) {
      const r = await c.call('POST', '/api/residents', { name, look: LOOK, plotId: 'kanda-3' });
      assert.equal(r.json.error, 'bad_name', name);
    }
    assert.equal((await c.call('POST', '/api/residents', { name: 'Subaru', look: LOOK, plotId: 'kanda-3' })).status, 200);
    h.db.run(`UPDATE residents SET name = 'SUB-01' WHERE wallet = ?`, c.w.address);    // named before the rule
    assert.equal((await c.call('POST', '/api/chat', { text: 'hello' })).json.error, 'impersonation');
  } finally { h.close(); }
});

test('chat quotas: 1 per 3 s, 30 per 10 min, 200 a day, identical text within 60 s', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    assert.equal((await a.call('POST', '/api/chat', { text: 'one' })).status, 200);
    const fast = await a.call('POST', '/api/chat', { text: 'two' });
    assert.equal(fast.status, 429);
    assert.ok(fast.json.retryAfterS >= 1 && fast.json.retryAfterS <= 3);
    const seed = (n, at, text = (i) => `m${i}`) => { for (let i = 0; i < n; i++) h.db.run(`INSERT INTO chat_messages (at, kind, wallet, name, text, dedupe_key) VALUES (?, 'resident', ?, 'Aiko', ?, ?)`, at, a.w.address, text(i), text(i)); };
    const reset = () => h.db.run('DELETE FROM chat_messages');

    reset(); seed(1, Date.now() - 5000, () => 'same');
    const dup = await a.call('POST', '/api/chat', { text: 'SAME!' });
    assert.equal(dup.status, 409); assert.equal(dup.json.error, 'duplicate');
    reset(); seed(1, Date.now() - 61_000, () => 'same');
    assert.equal((await a.call('POST', '/api/chat', { text: 'same' })).status, 200);

    reset(); seed(30, Date.now() - 60_000);
    const win = await a.call('POST', '/api/chat', { text: 'more' });
    assert.equal(win.status, 429); assert.match(win.json.message, /30 messages in 10 minutes/);
    reset(); seed(30, Date.now() - 601_000);
    assert.equal((await a.call('POST', '/api/chat', { text: 'more' })).status, 200);

    reset();
    const dayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    seed(200, dayStart);
    const day = await a.call('POST', '/api/chat', { text: 'again' });
    assert.equal(day.status, 429);
    if (Date.now() - dayStart > 600_000) assert.match(day.json.message, /200 messages a day/);
    // another wallet is not affected
    const b = await resident(h, 'Bo');
    assert.equal((await b.call('POST', '/api/chat', { text: 'again' })).status, 200);
  } finally { h.close(); }
});

test('chat presence: district and name only, at most every 20 s, removed when the last stream closes', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    const nobody = await signedIn(h);
    const viewer = await sse(h);
    await viewer.next('hello');
    const mine = await sse(h, a);
    await mine.next('hello');
    assert.equal((await nobody.call('POST', '/api/chat/presence', { district: 'ginza' })).json.error, 'no_resident');
    assert.equal((await a.call('POST', '/api/chat/presence', { district: 'atlantis' })).json.error, 'bad_district');
    assert.deepEqual((await a.call('POST', '/api/chat/presence', { district: 'ginza' })).json, { online: 1 });
    assert.deepEqual(await viewer.next('presence'), { online: [{ name: 'Aiko', district: 'ginza' }] });
    const again = await a.call('POST', '/api/chat/presence', { district: 'ueno' });
    assert.equal(again.status, 429);
    assert.ok(again.json.retryAfterS >= 19);
    const late = await sse(h);
    assert.deepEqual((await late.next('hello')).online, [{ name: 'Aiko', district: 'ginza' }]);
    assert.ok(!viewer.raw.includes(a.w.address) && !late.raw.includes(a.w.address));
    mine.close();                                           // Aiko's only stream: she leaves the list
    assert.deepEqual(await viewer.next('presence'), { online: [] });
    viewer.close(); late.close();
  } finally { h.close(); }
});

test('chat retention: messages older than 7 days are pruned on insert', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    const old = Date.now() - 7 * 86_400_000 - 1000;
    h.db.run(`INSERT INTO chat_messages (at, kind, wallet, name, text) VALUES (?, 'resident', ?, 'Aiko', 'ancient')`, old, a.w.address);
    h.db.run(`INSERT INTO chat_messages (at, kind, wallet, name, text) VALUES (?, 'resident', ?, 'Aiko', 'recent')`, Date.now() - 6 * 86_400_000, a.w.address);
    assert.equal((await a.call('POST', '/api/chat', { text: 'new' })).status, 200);
    assert.deepEqual(h.db.all('SELECT text FROM chat_messages ORDER BY id').map((x) => x.text), ['recent', 'new']);
  } finally { h.close(); }
});

test('chat moderation: one report per wallet, admin list with ?reported=1, admin delete broadcasts del', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    const b = await resident(h, 'Bo');
    const c = await signedIn(h);
    const admin = await signedIn(h, 'admin');
    const viewer = await sse(h);
    await viewer.next('hello');
    const m1 = (await a.call('POST', '/api/chat', { text: 'meh' })).json.message;
    assert.equal((await b.call('POST', '/api/chat', { text: 'fine' })).status, 200);
    assert.equal((await b.call('POST', '/api/chat/report', { id: m1.id })).status, 200);
    assert.equal((await b.call('POST', '/api/chat/report', { id: m1.id })).status, 200);
    assert.equal((await c.call('POST', '/api/chat/report', { id: m1.id })).status, 200);
    assert.equal((await c.call('POST', '/api/chat/report', { id: 999 })).status, 404);
    assert.equal((await b.call('GET', '/api/admin/chat?reported=1')).status, 403);
    const list = (await admin.call('GET', '/api/admin/chat?reported=1')).json.messages;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, m1.id); assert.equal(list[0].reports, 2); assert.equal(list[0].wallet, a.w.address);
    assert.equal((await admin.call('GET', '/api/admin/chat')).json.messages.length, 2);
    assert.equal((await b.call('DELETE', `/api/admin/chat/${m1.id}`)).status, 403);
    assert.equal((await admin.call('DELETE', `/api/admin/chat/${m1.id}`)).status, 200);
    assert.deepEqual(await viewer.next('del'), { id: m1.id });
    assert.equal((await admin.call('DELETE', `/api/admin/chat/${m1.id}`)).status, 404);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM chat_reports').n, 0);   // cascade
    viewer.close();
  } finally { h.close(); }
});

test('relay: state mapping from the live server\'s ticks and /api/mind, offline when quiet or closed, redial', async () => {
  const s = fakeSub01();
  let clock = 1_000_000, mind = { on: true, status: { resting: false } };
  const states = [];
  const relay = createRelay({ url: wsUrl('https://subzerone.live'), connect: s.connect, clock: () => clock,
    fetchMind: async () => mind, onState: (x) => states.push(x), opts: { backoffMinMs: 5, backoffMaxMs: 20, staleMs: 45_000 } });
  assert.equal(wsUrl('https://subzerone.live'), 'wss://subzerone.live/ws?lite=1&rate=1');
  assert.equal(wsUrl('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/ws?lite=1&rate=1');
  assert.deepEqual(relay.state(), { state: 'offline', atDesk: false, waiting: 0 });
  relay.start();
  await until(() => relay.open);
  assert.equal(s.url, 'wss://subzerone.live/ws?lite=1&rate=1');
  assert.equal(relay.state().state, 'offline');             // no tick yet: nothing known
  s.say({ type: 'hello', chat: [], replies: [{ t: '09:00', text: 'old reply' }] });
  s.tick('AWAKE', 'chat');
  assert.deepEqual(relay.state(), { state: 'awake', atDesk: true, waiting: 0 });
  s.tick('AWAKE', 'chat', true);
  assert.equal(relay.state().atDesk, false);                // walking to the desk is not at the desk
  s.tick('AWAKE', 'research');
  assert.equal(relay.state().atDesk, false);
  s.tick('NREM', 'sleep');
  assert.deepEqual(relay.state(), { state: 'asleep', atDesk: false, waiting: 0 });
  s.tick('REM', 'sleep');
  assert.equal(relay.state().state, 'asleep');
  mind = { on: true, status: { resting: true } };
  s.tick('AWAKE', 'chat');
  relay.track({ id: 1, name: 'Aiko', text: 'hi' });
  assert.equal(relay.state().waiting, 1);
  // resting comes from /api/mind (status.resting = over the daily AI cap)
  s.t.onopen();                                             // re-run the open hook: polls /api/mind now
  await until(() => relay.state().state === 'resting');
  assert.deepEqual(relay.state(), { state: 'resting', atDesk: true, waiting: 0 });
  mind = { on: true, status: { resting: false } };
  s.t.onopen();
  await until(() => relay.state().state === 'awake');
  assert.equal(relay.state().waiting, 1);
  clock += 1_800_001;                                       // his inbox forgets messages after 30 minutes
  s.tick('AWAKE', 'chat');
  assert.equal(relay.state().waiting, 0);
  clock += 46_000;                                          // quiet socket
  assert.equal(relay.state().state, 'offline');
  s.tick();
  assert.equal(relay.state().state, 'awake');
  const dials = s.dials;
  s.t.onclose();                                            // the live server went away
  assert.equal(relay.state().state, 'offline');
  assert.equal(states.at(-1).state, 'offline');
  await until(() => s.dials > dials && relay.open);         // redialled after the backoff
  s.say({ type: 'full' });                                  // the live server is full: it closes; we back off and retry
  await until(() => s.dials > dials + 1);
  relay.stop();
  assert.equal(relay.state().state, 'offline');
});

test('relay: viewer message format, acks in order, timeouts, replies matched and never invented', async () => {
  const s = fakeSub01();
  s.autoAck = false;
  const replies = [];
  const relay = createRelay({ url: 'ws://x/ws', connect: s.connect, onReply: (r) => replies.push(r), opts: { ackMs: 30 } });
  assert.deepEqual(await relay.send('hi', 'Aiko'), { ok: false, reason: 'offline', lost: true });
  relay.start();
  await until(() => relay.open);
  s.tick();
  const p1 = relay.send('hello SUB-01', '  Aiko   Tanaka ');
  const p2 = relay.send('second', 'A name longer than sixteen');
  assert.deepEqual(s.sent, [{ type: 'chat', text: 'hello SUB-01', nick: 'Aiko Tanaka' }, { type: 'chat', text: 'second' }]);
  s.say({ type: 'chat_ack', ok: true });
  s.say({ type: 'chat_ack', ok: false, reason: 'tickers are not allowed' });
  assert.deepEqual(await p1, { ok: true, reason: null });
  assert.deepEqual(await p2, { ok: false, reason: 'tickers are not allowed' });
  const p3 = relay.send('slow', 'Aiko');
  assert.deepEqual(await p3, { ok: false, reason: 'no answer', timeout: true });
  const p4 = relay.send('next', 'Aiko');
  s.say({ type: 'chat_ack', ok: true });                    // the late ack of "slow"
  s.say({ type: 'chat_ack', ok: false, reason: 'duplicate' });
  assert.deepEqual(await p4, { ok: false, reason: 'duplicate' });

  relay.track({ id: 42, name: 'Aiko', text: 'Hello SUB-01' });
  s.say({ type: 'chat', text: 'hello SUB-01', stage: 'AWAKE' });
  assert.equal(replies.length, 0);                          // an echo is not a reply
  const rec = { type: 'chat_reply', t: '10:02', text: 'hello, I am at my desk', to: 'a viewer', replying_to: 'hello sub-01!', tag: 'his reply (AI-written)', source: 'ai' };
  s.say(rec);
  s.say(rec);                                               // the same broadcast twice is relayed once
  s.say({ type: 'chat_reply', t: '10:05', text: 'a room viewer asked', replying_to: 'what are you reading?' });
  assert.deepEqual(replies, [
    { text: 'hello, I am at my desk', replyingTo: { id: 42, name: 'Aiko', text: 'Hello SUB-01' } },
    { text: 'a room viewer asked', replyingTo: { id: null, name: null, text: 'what are you reading?' } },
  ]);
  const p5 = relay.send('lost', 'Aiko');
  s.t.onclose();
  assert.deepEqual(await p5, { ok: false, reason: 'connection lost', lost: true });
  relay.stop();
});

test('POST /api/chat/sub01: forwarded over the shared socket, his reply relayed as kind sub01 without a tag', async () => {
  const s = fakeSub01();
  const h = await harness({}, { chat: { connect: s.connect, limits: { sub01: { cityGapMs: 0 } } } });
  try {
    const a = await resident(h, 'Aiko');
    const b = await resident(h, 'Bo');
    const nobody = await signedIn(h);
    const offline = await a.call('POST', '/api/chat/sub01', { text: 'are you there?' });
    assert.equal(offline.status, 503);                      // relay not open yet: nothing is sent, nothing invented
    assert.equal(offline.json.error, 'sub01_offline');
    const viewer = await sse(h);
    await viewer.next('hello');
    await until(() => h.app.chat.relay.open);
    s.tick('AWAKE', 'chat');
    assert.deepEqual(await viewer.next('sub01', (x) => x.state === 'awake'), { state: 'awake', atDesk: true, waiting: 0 });

    assert.equal((await nobody.call('POST', '/api/chat/sub01', { text: 'hi' })).json.error, 'no_resident');
    assert.equal((await a.call('POST', '/api/chat/sub01', { text: 'SUB-01: hi' })).json.error, 'impersonation');
    const r = await a.call('POST', '/api/chat/sub01', { text: 'what are you reading?', district: 'shibuya' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s.sent.at(-1), { type: 'chat', text: 'what are you reading?', nick: 'Aiko' });
    const m = r.json.message;
    assert.deepEqual({ ...m, id: 0, at: 0 }, { id: 0, at: 0, name: 'Aiko', text: 'what are you reading?', district: 'shibuya', plotId: null, kind: 'resident', to: 'sub01' });
    assert.deepEqual(r.json.sub01, { state: 'awake', atDesk: true, waiting: 1 });
    assert.deepEqual(await viewer.next('msg'), m);
    assert.equal((await viewer.next('sub01', (x) => x.waiting === 1)).state, 'awake');

    const again = await a.call('POST', '/api/chat/sub01', { text: 'and now?' });
    assert.equal(again.status, 429);                        // 1 per 20 s per wallet
    assert.ok(again.json.retryAfterS > 15);

    s.say({ type: 'chat_reply', t: '10:02', text: 'a page about tea ceremonies', to: 'a viewer', replying_to: 'what are you reading?', tag: 'his reply (AI-written)', source: 'ai' });
    const reply = await viewer.next('msg', (x) => x.kind === 'sub01');
    assert.deepEqual(Object.keys(reply).sort(), ['at', 'district', 'id', 'kind', 'name', 'plotId', 'replyingTo', 'text']);
    assert.equal(reply.tag, undefined);
    assert.deepEqual({ ...reply, id: 0, at: 0 }, { id: 0, at: 0, name: 'SUB-01', text: 'a page about tea ceremonies', district: null, plotId: null, kind: 'sub01',
      replyingTo: { id: m.id, name: 'Aiko', text: 'what are you reading?' } });
    assert.equal((await viewer.next('sub01', (x) => x.waiting === 0)).state, 'awake');
    const late = await sse(h);
    assert.deepEqual((await late.next('hello')).recent.map((x) => x.kind), ['resident', 'sub01']);

    s.ack = { type: 'chat_ack', ok: false, reason: 'tickers are not allowed' };
    const refused = await b.call('POST', '/api/chat/sub01', { text: 'buy $PEPE' });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.reason, 'tickers are not allowed');
    s.ack = { type: 'chat_ack', ok: false, reason: 'one message every 10 s' };
    assert.equal((await b.call('POST', '/api/chat/sub01', { text: 'hello' })).json.error, 'sub01_busy');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM chat_messages WHERE wallet = ? AND to_sub01 = 1', b.w.address).n, 0);   // refused = not shown, not counted

    s.ack = { type: 'chat_ack', ok: true };
    s.tick('NREM', 'sleep');
    assert.equal((await viewer.next('sub01', (x) => x.state === 'asleep')).atDesk, false);
    const asleep = await b.call('POST', '/api/chat/sub01', { text: 'good night' });
    assert.equal(asleep.status, 200);                       // he hears it asleep (the live server takes it); no reply follows
    assert.deepEqual(asleep.json.sub01, { state: 'asleep', atDesk: false, waiting: 0 });
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(viewer.events.filter((e) => e.event === 'msg' && e.data.kind === 'sub01').length, 1);

    s.t.onclose();
    assert.deepEqual(await viewer.next('sub01', (x) => x.state === 'offline'), { state: 'offline', atDesk: false, waiting: 0 });
    viewer.close(); late.close();
  } finally { h.close(); }
});

test('POST /api/chat/sub01: the city shares one message per 10 s to the live server, 20 a day per wallet', async () => {
  const s = fakeSub01();
  const h = await harness({}, { chat: { connect: s.connect } });
  try {
    const a = await resident(h, 'Aiko');
    const b = await resident(h, 'Bo');
    const v = await sse(h);
    await until(() => h.app.chat.relay.open);
    s.tick();
    assert.equal((await a.call('POST', '/api/chat/sub01', { text: 'first' })).status, 200);
    const busy = await b.call('POST', '/api/chat/sub01', { text: 'second' });
    assert.equal(busy.status, 429);
    assert.equal(busy.json.error, 'sub01_busy');
    assert.equal(s.sent.length, 1);
    h.db.run('DELETE FROM chat_messages');
    const dayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    for (let i = 0; i < 20; i++) h.db.run(`INSERT INTO chat_messages (at, kind, wallet, name, text, to_sub01) VALUES (?, 'resident', ?, 'Bo', ?, 1)`, dayStart, b.w.address, `m${i}`);
    const day = await b.call('POST', '/api/chat/sub01', { text: 'third' });
    assert.equal(day.status, 429);
    if (Date.now() - dayStart > 20_000) assert.match(day.json.message, /20 messages to SUB-01 a day/);
    v.close();
  } finally { h.close(); }
});

test('chat stream: at most N connections per address', async () => {
  const h = await harness({}, { chat: { limits: { perIp: 2 } } });
  try {
    const one = await sse(h), two = await sse(h);
    await one.next('hello'); await two.next('hello');
    const r = await fetch(`${h.base}/api/chat/stream`);
    assert.equal(r.status, 429);
    await r.text();
    assert.equal(h.app.chat.conns.size, 2);
    one.close();
    await until(() => h.app.chat.conns.size === 1);
    two.close();
  } finally { h.close(); }
});

test('chat stream: heartbeat comments, and a connection idle past the limit is dropped', async () => {
  const h = await harness({}, { chat: { limits: { idleMs: 120, heartbeatMs: 30 } } });
  try {
    const one = await sse(h);
    await one.next('hello');
    await until(() => one.raw.includes('\n:\n\n'));
    await until(() => h.app.chat.conns.size === 0, 1000);
    one.close();
  } finally { h.close(); }
});

test('wsConnect: a handshake that only errors (Node WebSocket, live server down) still closes the transport, so the relay redials', async () => {
  const { wsConnect } = await import('../src/sub01relay.js');
  const t = wsConnect('ws://127.0.0.1:9/ws');            // nothing listens: Node fires error, never close
  let closes = 0;
  t.onclose = () => { closes++; };
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(closes, 1);
});
