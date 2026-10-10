// Live walkers (chat.js validateWalk / walk, POST /api/presence): validation, the 2/s rule, the TTL, the snapshot in
// `hello`, logout and stream close, and that no frame ever carries a wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, user } from './helpers.js';
import { validateWalk, walkerView, WALK_BOX, CHAT } from '../src/chat.js';

const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#ff6600', bottom: '#222222', outfit: 'hoodie' };
let plotN = 0;
const PLOTS = ['shibuya-1', 'shibuya-2', 'ginza-1', 'ginza-2', 'ueno-1', 'ueno-2', 'kanda-1', 'kanda-2'];
async function resident(h, name) {
  const c = h.client(user(h.db));
  await c.signIn();
  const r = await c.call('POST', '/api/residents', { name, look: LOOK, plotId: PLOTS[plotN++ % PLOTS.length] });
  assert.equal(r.status, 200, r.text);
  return c;
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An SSE reader (as in chat.test.js): `next(event, pred)` returns the next matching event. */
async function sse(h, c) {
  const ac = new AbortController();
  const res = await fetch(`${h.base}/api/chat/stream`, { headers: c?.cookie ? { cookie: c.cookie } : {}, signal: ac.signal });
  const events = [];
  let raw = '';
  const cursor = {};
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
          }
          buf = buf.slice(i + 2);
          if (ev.event) events.push(ev);
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events, get raw() { return raw; },
    async next(event, pred = () => true, ms = 2000) {
      let hit = -1;
      await until(() => (hit = events.findIndex((e, i) => i >= (cursor[event] ?? 0) && e.event === event && pred(e.data))) >= 0, ms);
      cursor[event] = hit + 1;
      return events[hit].data;
    },
    /** The next walker update of either shape, as a list. */
    async walkers(pred = () => true, ms = 2000) {
      let hit = -1;
      await until(() => (hit = events.findIndex((e, i) => i >= (cursor.w ?? 0) && (e.event === 'walker' || e.event === 'walkers')
        && (e.event === 'walker' ? [e.data] : e.data).some(pred))) >= 0, ms);
      cursor.w = hit + 1;
      const e = events[hit];
      return e.event === 'walker' ? [e.data] : e.data;
    },
    close: () => ac.abort(),
  };
}

const WALK = { state: 'walk', x: 10, z: 2.35, yaw: 1.57, speed: 2.2, path: [{ x: 10, z: 2.35 }, { x: 20, z: 2.35 }] };

test('presence validation: states, numbers inside the city box, the path clamped, nothing extra', () => {
  const v = validateWalk({ ...WALK, emote: 'wave' });
  assert.deepEqual(v, { state: 'walk', x: 10, z: 2.35, yaw: 1.57, speed: 2.2, path: WALK.path, emote: 'wave' });
  assert.deepEqual(validateWalk({ state: 'home', x: 'ignored' }), { state: 'home' });
  assert.deepEqual(validateWalk({ state: 'idle', x: 0, z: 0 }), { state: 'idle', x: 0, z: 0, yaw: 0, speed: 0, path: null, emote: null });
  assert.deepEqual(validateWalk({ state: 'walk', x: 0, z: 0, path: [] }).path, []);
  const long = { ...WALK, path: Array.from({ length: 40 }, (_, i) => ({ x: i, z: 2 })) };
  assert.equal(validateWalk(long).path.length, CHAT.walkPathMax);
  assert.equal(validateWalk(long, { pathMax: 3 }).path.length, 3);
  assert.equal(validateWalk({ ...WALK, x: 10.123456 }).x, 10.12);
  const bad = (b, re) => assert.throws(() => validateWalk(b), (e) => e.status === 400 && e.code === 'bad_presence' && re.test(e.message));
  bad(null, /object/); bad([], /object/); bad({ ...WALK, wallet: 'x' }, /unknown field/); bad({ ...WALK, state: 'fly' }, /state/);
  bad({ ...WALK, x: WALK_BOX.maxX + 1 }, /^x:/); bad({ ...WALK, z: 'near' }, /^z:/); bad({ ...WALK, x: NaN }, /^x:/);
  bad({ ...WALK, yaw: 99 }, /yaw/); bad({ ...WALK, speed: -1 }, /speed/); bad({ ...WALK, path: 'nope' }, /path/);
  bad({ ...WALK, path: [{ x: 0 }] }, /path\[0\]\.z/); bad({ ...WALK, path: [{ x: 0, z: 999 }] }, /path\[0\]\.z/); bad({ ...WALK, path: [5] }, /path\[0\]/);
  bad({ ...WALK, emote: 'x'.repeat(40) }, /emote/); bad({ ...WALK, emote: 'Hi there' }, /emote/);
  // the public view carries no wallet whatever the stored record holds
  const view = walkerView({ id: 'abc', wallet: 'SECRET', name: 'Aiko', plotId: 'ginza-1', look: LOOK, ...v, at: 1 });
  assert.ok(!('wallet' in view)); assert.equal(view.emote, 'wave'); assert.equal(view.id, 'abc');
  assert.ok(!('emote' in walkerView({ id: 'a', name: 'n', plotId: 'p', look: {}, ...validateWalk(WALK), at: 1 })));
});

test('presence: guests 401, no resident 409, bad body 400, walker frames with name + look and never the wallet', async () => {
  const h = await harness();
  try {
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('POST', '/api/presence', WALK)).status, 401);
    await anon.signIn();
    assert.equal((await anon.call('POST', '/api/presence', WALK)).json.error, 'no_resident');
    const a = await resident(h, 'Aiko');
    assert.equal((await a.call('POST', '/api/presence', { ...WALK, x: 5000 })).json.error, 'bad_presence');
    assert.equal((await a.call('POST', '/api/presence', { ...WALK, path: Array.from({ length: 60 }, () => ({ x: 0, z: 0 })) })).status, 413, 'body over 600 B');
    const viewer = await sse(h);
    const hello = await viewer.next('hello');
    assert.deepEqual(hello.walkers, []);
    const r = await a.call('POST', '/api/presence', WALK);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.id, /^[0-9a-f]{16}$/);
    const [w] = await viewer.walkers();
    assert.equal(w.id, r.json.id);
    assert.deepEqual({ ...w, at: 0 }, { id: r.json.id, name: 'Aiko', plotId: 'shibuya-1', look: { ...LOOK, accessories: [], accessoryColor: null, pet: null },
      state: 'walk', x: 10, z: 2.35, yaw: 1.57, path: WALK.path, speed: 2.2, at: 0 });
    assert.ok(w.at > 0 && !viewer.raw.includes(a.w.address));
    // the id is not derived from the wallet in any readable way, and the resident's own stream learns its own id
    assert.ok(!a.w.address.includes(w.id));
    const mine = await sse(h, a);
    const myHello = await mine.next('hello');
    assert.equal(myHello.you.walker, r.json.id);
    assert.equal(myHello.walkers.length, 1, 'snapshot on connect');
    assert.equal(myHello.walkers[0].name, 'Aiko');
    assert.ok(!mine.raw.includes(a.w.address));
    // a fix without a path keeps the last path; an idle fix clears it
    await sleep(600);
    assert.equal((await a.call('POST', '/api/presence', { state: 'walk', x: 12, z: 2.35, yaw: 1.57, speed: 2.2 })).status, 200);
    assert.deepEqual((await viewer.walkers((x) => x.x === 12))[0].path, WALK.path);
    await sleep(600);
    assert.equal((await a.call('POST', '/api/presence', { state: 'idle', x: 20, z: 2.35 })).status, 200);
    assert.deepEqual((await viewer.walkers((x) => x.state === 'idle'))[0].path, []);
    // home: a short frame, and the snapshot is empty again
    await sleep(600);
    assert.deepEqual((await a.call('POST', '/api/presence', { state: 'home' })).json, { id: r.json.id, state: 'home' });
    const [gone] = await viewer.walkers((x) => x.state === 'home');
    assert.deepEqual(Object.keys(gone).sort(), ['at', 'id', 'name', 'plotId', 'state']);
    const late = await sse(h);
    assert.deepEqual((await late.next('hello')).walkers, []);
    viewer.close(); mine.close(); late.close();
  } finally { h.close(); }
});

test('presence: at most 2 posts a second per wallet, several changes in 250 ms become one `walkers` frame', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko'), b = await resident(h, 'Bo');
    const viewer = await sse(h);
    await viewer.next('hello');
    assert.equal((await a.call('POST', '/api/presence', WALK)).status, 200);
    assert.equal((await a.call('POST', '/api/presence', { ...WALK, x: 11 })).status, 200);
    const third = await a.call('POST', '/api/presence', { ...WALK, x: 12 });
    assert.equal(third.status, 429);
    assert.equal(third.json.retryAfterS, 1);
    assert.equal((await b.call('POST', '/api/presence', { ...WALK, x: 30, state: 'idle' })).status, 200, 'the rule is per wallet');
    const batch = await viewer.walkers();
    assert.equal(batch.length, 2, 'one coalesced frame (Aiko once, at her latest fix, and Bo)');
    assert.deepEqual(batch.map((w) => [w.name, w.x, w.state]), [['Aiko', 11, 'walk'], ['Bo', 30, 'idle']]);
    await sleep(1000);
    assert.equal((await a.call('POST', '/api/presence', { ...WALK, x: 13 })).status, 200, 'a second later the budget is back');
    assert.deepEqual((await viewer.walkers()).map((w) => w.x), [13]);
    viewer.close();
  } finally { h.close(); }
});

test('presence: a walker that stops posting goes home after the TTL; logout and the last stream closing send it home too', async () => {
  const h = await harness({}, { chat: { limits: { walkTtlMs: 300 } } });
  try {
    const a = await resident(h, 'Aiko'), b = await resident(h, 'Bo'), c = await resident(h, 'Cy');
    const viewer = await sse(h);
    await viewer.next('hello');
    assert.equal((await a.call('POST', '/api/presence', WALK)).status, 200);
    await viewer.walkers((w) => w.name === 'Aiko' && w.state === 'walk');
    const t0 = Date.now();
    const [gone] = await viewer.walkers((w) => w.name === 'Aiko' && w.state === 'home');
    assert.ok(Date.now() - t0 < 1500 && gone.id);
    assert.equal(h.app.chat.walkers.size, 0);
    // logout
    assert.equal((await b.call('POST', '/api/presence', { ...WALK, x: 40 })).status, 200);
    await viewer.walkers((w) => w.name === 'Bo' && w.state === 'walk');
    assert.equal((await b.call('POST', '/api/auth/logout')).status, 200);
    await viewer.walkers((w) => w.name === 'Bo' && w.state === 'home');
    // the last stream of the wallet closing
    const cs = await sse(h, c);
    await cs.next('hello');
    assert.equal((await c.call('POST', '/api/presence', { ...WALK, x: 50 })).status, 200);
    await viewer.walkers((w) => w.name === 'Cy' && w.state === 'walk');
    cs.close();
    await viewer.walkers((w) => w.name === 'Cy' && w.state === 'home');
    assert.ok(!viewer.raw.includes(a.w.address) && !viewer.raw.includes(b.w.address) && !viewer.raw.includes(c.w.address));
    viewer.close();
  } finally { h.close(); }
});

test('presence: online counts residents with a live stream, from the first byte', async () => {
  const h = await harness();
  try {
    const a = await resident(h, 'Aiko');
    const viewer = await sse(h);
    await viewer.next('hello');
    const mine = await sse(h, a);
    assert.deepEqual((await mine.next('hello')).online, [{ name: 'Aiko', district: null }]);
    assert.deepEqual(await viewer.next('presence'), { online: [{ name: 'Aiko', district: null }] });
    mine.close();
    assert.deepEqual(await viewer.next('presence'), { online: [] });
    viewer.close();
  } finally { h.close(); }
});
