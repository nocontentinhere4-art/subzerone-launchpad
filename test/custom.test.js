// Customization: look v2 (accessories, pet), traits, unlock tiers from the pipeline, special room items, guestbooks,
// and /api/world city events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, user, drain, IDEA, ideaStatus, SUB01_WALLET } from './helpers.js';
import { validateLook, validateTraits, unlocksFor, UNLOCKS, ROOM_CATALOG, GUESTBOOK, cityEvents } from '../src/world.js';
import { transition } from '../src/states.js';
import { utcDay } from '../src/util.js';

const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#ff6600', bottom: '#222222', outfit: 'hoodie' };
const ROOM = { materials: { floor: 'tatami', walls: 'sage', accent: 'rust' }, lighting: 'night', furniture: [] };

async function signedIn(h) {
  const c = h.client(user(h.db));
  await c.signIn();
  return c;
}
const resident = (c, plotId, extra = {}) => c.call('POST', '/api/residents', { name: extra.name || 'Kenji', look: LOOK, plotId, ...extra });

function launched(db, owner, slug = 'ramen', ticker = 'RAMEN') {
  const t = Date.now();
  const recipients = [{ label: 'Idea submitter', wallet: owner, bps: 8000, role: 'submitter' }, { label: 'SUB-01', wallet: SUB01_WALLET, bps: 2000, role: 'sub01' }];
  const config = { feeSharing: { mode: 'sharing_config', shareholders: recipients.map(({ wallet, bps }) => ({ wallet, bps })), recipients, locked: true } };
  db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, 'launched', 'public', ?, ?)`, `idea_${slug}`, owner, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'd', ?, ?)`, `prj_${slug}`, `idea_${slug}`, slug, slug, ticker, t, t);
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES (?, ?, 1, ?, 10000, 'locked', ?)`, `al_${slug}`, `prj_${slug}`, JSON.stringify(recipients), t);
  db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
          VALUES (?, ?, 'mock', 'mock', ?, 'h', ?, ?, ?, 'confirmed', ?, ?)`, `in_${slug}`, `prj_${slug}`, JSON.stringify(config), `al_${slug}`, `Mint${slug}`, owner, t, t);
  db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, 'mock', 'mock', ?, ?, '[]', ?)`, `prj_${slug}`, `in_${slug}`, `Mint${slug}`, `sig${slug}`, t);
}

test('look v2 and traits: accessories, accessory colour, pet, trait defaults and rounding, strict limits', () => {
  const ok = validateLook({ ...LOOK, accessories: ['glasses', 'cap'], accessoryColor: '#AABBCC', pet: { kind: 'cat', color: '#FFFFFF', name: '  Mochi   Chan ' } });
  assert.deepEqual(ok.accessories, ['glasses', 'cap']);
  assert.equal(ok.accessoryColor, '#aabbcc');
  assert.deepEqual(ok.pet, { kind: 'cat', color: '#ffffff', name: 'Mochi Chan' });
  assert.deepEqual(validateLook(LOOK), { ...LOOK, accessories: [], accessoryColor: null, pet: null }, 'v1 looks still valid');
  assert.equal(validateLook({ ...LOOK, accessories: ['halo', 'wings', 'crown', 'jetpack'] }).accessories.length, 4, '4 fit');
  const bad = (patch) => assert.throws(() => validateLook({ ...LOOK, ...patch }), (e) => e.code === 'bad_look', JSON.stringify(patch));
  bad({ accessories: ['glasses', 'cap', 'mask', 'scarf', 'halo'] });
  bad({ accessories: ['glasses', 'glasses'] });
  bad({ accessories: ['tophat'] });
  bad({ accessories: ['__proto__'] });
  bad({ accessories: 'glasses' });
  bad({ accessoryColor: 'red' });
  bad({ pet: { kind: 'tiger', color: '#ffffff', name: 'Tora' } });
  bad({ pet: { kind: 'cat', color: 'white', name: 'Tora' } });
  bad({ pet: { kind: 'cat', color: '#ffffff', name: '' } });
  bad({ pet: { kind: 'cat', color: '#ffffff', name: 'x'.repeat(13) } });
  bad({ pet: { kind: 'cat', color: '#ffffff', name: '<b>hi</b>' } });
  bad({ pet: { kind: 'cat', color: '#ffffff', name: 'Tora', age: 2 } });
  bad({ pet: ['cat'] });
  assert.equal(validateLook({ ...LOOK, pet: { kind: 'dog', color: '#000000', name: 'X' } }).pet.name, 'X', 'a 1-character pet name');

  assert.deepEqual(validateTraits({}), { neat: 0.5, outgoing: 0.5, active: 0.5, playful: 0.5, nice: 0.5 });
  assert.deepEqual(validateTraits({ neat: 0.456, nice: 1, active: 0 }), { neat: 0.46, outgoing: 0.5, active: 0, playful: 0.5, nice: 1 });
  for (const t of [{ neat: 1.01 }, { neat: -0.1 }, { neat: '0.5' }, { neat: null, evil: 1 }, { brave: 0.5 }, [], null]) {
    assert.throws(() => validateTraits(t), (e) => e.code === 'bad_traits', JSON.stringify(t));
  }
});

test('residents v2 over HTTP: traits stored, kept when omitted, public in /api/world; options carry the catalogs', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    assert.equal((await resident(a, 'shiba-1', { traits: { neat: 2 } })).json.error, 'bad_traits');
    const one = await resident(a, 'shiba-1', { look: { ...LOOK, accessories: ['headphones'], pet: { kind: 'duck', color: '#ffee00', name: 'Ahiru' } }, traits: { outgoing: 0.9 } });
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(one.json.resident.traits, { neat: 0.5, outgoing: 0.9, active: 0.5, playful: 0.5, nice: 0.5 });
    const again = await resident(a, null, { look: LOOK });
    assert.equal(again.json.resident.traits.outgoing, 0.9, 'omitted traits are kept');
    assert.deepEqual(again.json.resident.look.accessories, [], 'the look is replaced');
    await resident(a, null, { look: { ...LOOK, accessories: ['scarf'] }, traits: { playful: 0.33 } });
    const w = await h.client(user(h.db)).call('GET', '/api/world');
    const r = w.json.plots.find((p) => p.plotId === 'shiba-1').resident;
    assert.deepEqual(r.traits, { neat: 0.5, outgoing: 0.5, active: 0.5, playful: 0.33, nice: 0.5 }, 'given traits replace all five (missing = 0.5)');
    assert.deepEqual(r.look.accessories, ['scarf']);
    assert.ok(!w.text.includes(a.w.address));
    const me = await a.call('GET', '/api/me');
    assert.equal(me.json.resident.traits.playful, 0.33);
    assert.equal(me.json.unlocks.tier, 'resident');
    const o = await a.call('GET', '/api/world/options');
    assert.deepEqual(o.json.unlocks, JSON.parse(JSON.stringify(UNLOCKS)));
    assert.deepEqual(o.json.room.catalog.special, ROOM_CATALOG.special);
    assert.equal(o.json.look.accessories.length, 14);
    assert.deepEqual(o.json.traits.keys, ['neat', 'outgoing', 'active', 'playful', 'nice']);
    // every accessory and pet is unlocked by exactly one tier
    assert.deepEqual(Object.values(UNLOCKS.accessories).flat().sort(), [...o.json.look.accessories].sort());
    assert.deepEqual(Object.values(UNLOCKS.pets).flat().sort(), [...o.json.look.pets].sort());
  } finally { h.close(); }
});

test('unlock tiers follow the pipeline: none, resident, builder (selected), founder (site), launched; rooms show public tiers only', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    assert.deepEqual(unlocksFor(h.db, a.w.address), { tier: null, items: [], emotes: [], accessories: [], pets: [] });
    await resident(a, 'meguro-1');
    const r0 = unlocksFor(h.db, a.w.address);
    assert.equal(r0.tier, 'resident');
    assert.deepEqual(r0.emotes, UNLOCKS.emotes.resident);
    // selected (still private)
    const sub = await a.call('POST', '/api/ideas', IDEA(a.w));
    h.db.run(`DELETE FROM jobs`);                                        // walk the stages by hand
    transition(h.db, sub.json.id, 'submitted', 'evaluating');
    assert.equal(unlocksFor(h.db, a.w.address).tier, 'resident', 'evaluating is not selected');
    transition(h.db, sub.json.id, 'evaluating', 'selected');
    const b = unlocksFor(h.db, a.w.address);
    assert.equal(b.tier, 'builder');
    assert.deepEqual(b.pets, ['cat', 'dog', 'duck', 'slime', 'robot']);
    assert.deepEqual(b.items, [...UNLOCKS.items.resident, ...UNLOCKS.items.builder], 'a tier includes the lower ones');
    transition(h.db, sub.json.id, 'selected', 'cancelled');
    assert.equal(unlocksFor(h.db, a.w.address).tier, 'builder', 'reached once = kept (the selection is on record)');
    // a built site -> founder (the full pipeline with the fake brain)
    const two = await a.call('POST', '/api/ideas', IDEA(a.w, { title: 'Second one', concept: 'A small coin about the vending machines of Tokyo, mapped and rated by the people who use them at night.' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, two.json.id).status, 'preview_ready');
    const f = (await a.call('GET', '/api/me')).json.unlocks;
    assert.equal(f.tier, 'founder');
    assert.deepEqual(f.accessories.slice(-2), ['halo', 'wings']);
    assert.ok(f.items.includes('trophySite') && !f.items.includes('goldToilet'));
    // visitors see only what public ideas earned: both ideas are private
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', '/api/rooms/meguro-1')).json.unlocks.tier, 'resident');
    await a.call('POST', `/api/ideas/${two.json.id}/publish`, { public: true });
    assert.equal((await anon.call('GET', '/api/rooms/meguro-1')).json.unlocks.tier, 'founder');
    launched(h.db, a.w.address);
    const l = (await a.call('GET', '/api/me')).json.unlocks;
    assert.equal(l.tier, 'launched');
    assert.equal(l.items.length, 16);
    assert.deepEqual(l.emotes.slice(-2), ['celebrate', 'moonwalk']);
    assert.equal(l.accessories.length, 14);
    assert.equal(l.pets.length, 6);
    // a wallet with progress but no resident yet: the tier counts already
    const c = user(h.db);
    launched(h.db, c.address, 'solo', 'SOLO');
    assert.equal(unlocksFor(h.db, c.address).tier, 'launched');
  } finally { h.close(); }
});

test('locked: 403 with the locked names on resident save and room save; unlocked ones pass', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    const r = await resident(a, 'nakano-1', { look: { ...LOOK, accessories: ['glasses', 'halo', 'crown'], pet: { kind: 'dragon', color: '#ff0000', name: 'Ryu' } } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'locked');
    assert.deepEqual(r.json.locked, ['halo', 'crown', 'dragon']);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM residents').n, 0, 'nothing saved');
    assert.equal((await resident(a, 'nakano-1', { look: { ...LOOK, accessories: ['glasses', 'cap', 'mask', 'scarf'], pet: { kind: 'cat', color: '#ffffff', name: 'Tama' } } })).status, 200,
      'resident-tier accessories and pets on the very first save');
    assert.equal((await resident(a, null, { look: { ...LOOK, accessories: ['cat_ears'] } })).json.error, 'locked');
    const put = (furniture) => a.call('PUT', '/api/rooms/me', { room: { ...ROOM, furniture } });
    const lr = await put([{ item: 'skateboard', x: 0, z: 0, rot: 0 }, { item: 'discoBall', x: 0, z: 0, rot: 0, y: 2.4 }, { item: 'goldToilet', x: 1, z: 1, rot: 90 }]);
    assert.equal(lr.status, 403);
    assert.deepEqual(lr.json.locked, ['discoBall', 'goldToilet']);
    const ok = await put([{ item: 'skateboard', x: 0, z: 0, rot: 0 }, { item: 'neonSign', x: -3.4, z: 0, rot: 90, y: 1.5 }]);
    assert.equal(ok.status, 200, ok.text);
    // builder: the arcade cabinet opens up
    h.db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES ('idea_b', ?, 'generating', 'private', 1, 1)`, a.w.address);
    assert.equal((await put([{ item: 'arcadeCabinet', x: 0, z: 0, rot: 0 }])).status, 200);
    assert.equal((await resident(a, null, { look: { ...LOOK, accessories: ['cat_ears', 'antenna'], pet: { kind: 'robot', color: '#cccccc', name: 'Bot' } } })).status, 200);
  } finally { h.close(); }
});

test('text items: posterCustom free text, neonTicker = one of your public tickers (default: the launched one), private tickers never shown', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    await resident(a, 'ginza-1');
    const put = (furniture) => a.call('PUT', '/api/rooms/me', { room: { ...ROOM, furniture } });
    const poster = await put([{ item: 'posterCustom', x: 0, z: -3.4, rot: 0, y: 1.2, text: '  gm   tokyo ' }]);
    assert.equal(poster.status, 200, poster.text);
    assert.equal(poster.json.room.furniture[0].text, 'gm tokyo');
    assert.equal((await put([{ item: 'posterCustom', x: 0, z: 0, rot: 0, text: 'x'.repeat(13) }])).json.error, 'bad_room');
    assert.equal((await put([{ item: 'posterCustom', x: 0, z: 0, rot: 0, text: 12 }])).json.error, 'bad_room');
    assert.equal((await put([{ item: 'desk', x: 0, z: 0, rot: 0, text: 'hi' }])).json.error, 'bad_room', 'only text items take text');
    assert.equal((await put([{ item: 'neonTicker', x: 0, z: 0, rot: 0 }])).json.error, 'locked');
    launched(h.db, a.w.address);
    const def = await put([{ item: 'neonTicker', x: 0, z: -3.4, rot: 0, y: 2 }]);
    assert.equal(def.status, 200, def.text);
    assert.equal(def.json.room.furniture[0].text, 'RAMEN', 'defaults to the launched ticker');
    assert.equal((await put([{ item: 'neonTicker', x: 0, z: 0, rot: 0, text: 'ramen' }])).json.room.furniture[0].text, 'RAMEN', 'uppercased');
    const other = await put([{ item: 'neonTicker', x: 0, z: 0, rot: 0, text: 'PEPE' }]);
    assert.equal(other.json.error, 'bad_room');
    assert.match(other.json.message, /RAMEN/);
    // a second, private project: its ticker is refused; once public it is fine, and hidden again if made private
    const sub = await a.call('POST', '/api/ideas', IDEA(a.w, { tickerSuggestion: 'SAUCE' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const ticker = h.db.get('SELECT ticker FROM projects WHERE idea_id = ?', sub.json.id).ticker;
    assert.equal((await put([{ item: 'neonTicker', x: 0, z: 0, rot: 0, text: ticker }])).json.error, 'bad_room', 'private ticker refused');
    await a.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    assert.equal((await put([{ item: 'neonTicker', x: 0, z: 0, rot: 0, text: ticker }, { item: 'neonTicker', x: 1, z: 0, rot: 0 }])).status, 200);
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', '/api/rooms/ginza-1')).json.room.furniture.length, 2);
    await a.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: false });
    const seen = await anon.call('GET', '/api/rooms/ginza-1');
    assert.deepEqual(seen.json.room.furniture.map((f) => f.text), ['RAMEN'], 'the now-private ticker is not shown');
    assert.ok(!seen.text.includes(ticker));
    assert.equal((await a.call('GET', '/api/me')).json.resident.room.furniture.length, 2, 'the owner still has both');
  } finally { h.close(); }
});

test('guestbook: residents only, not the owner, cleaned text, 1/min/room and 20/day, latest 50, delete by owner or author, never a wallet', async () => {
  const h = await harness();
  try {
    const owner = await signedIn(h);
    const vis = await signedIn(h);
    const third = await signedIn(h);
    await resident(owner, 'koenji-1', { name: 'Owner' });
    const post = (c, text, plot = 'koenji-1') => c.call('POST', `/api/rooms/${plot}/guestbook`, { text });
    assert.equal((await post(vis, 'hi')).json.error, 'no_resident');
    await resident(vis, 'koenji-2', { name: 'Visitor Yui' });
    await resident(third, 'koenji-3', { name: 'Third' });
    assert.equal((await post(owner, 'my own room')).json.error, 'own_room');
    assert.equal((await post(vis, 'hi', 'koenji-6')).status, 404, 'nobody lives there');
    assert.equal((await post(vis, 'hi', 'mars-1')).json.error, 'bad_plot');
    assert.equal((await post(vis, '   ')).json.error, 'bad_text');
    assert.equal((await post(vis, 'x'.repeat(81))).json.error, 'bad_text');
    assert.equal((await vis.call('POST', '/api/rooms/koenji-1/guestbook', { text: 'hi' }, { cookie: '' })).status, 401);
    const ok = await post(vis, `  nice <b>room</b> 🍜🔥   ${owner.w.address}`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.entry.name, 'Visitor Yui');
    assert.ok(ok.json.entry.text.startsWith('nice b room /b 🍜🔥 '), ok.json.entry.text);
    assert.ok(!ok.json.entry.text.includes(owner.w.address), 'address-like text is shortened');
    const again = await post(vis, 'second');
    assert.equal(again.status, 429);
    assert.equal(again.json.error, 'rate_limited');
    assert.ok(again.json.retryAfterS > 0 && again.json.retryAfterS <= 60);
    assert.equal((await post(vis, 'other room', 'koenji-3')).status, 200, 'the minute limit is per room');
    assert.equal((await post(third, 'hello from third')).status, 200);
    const anon = h.client(user(h.db));
    let room = await anon.call('GET', '/api/rooms/koenji-1');
    assert.deepEqual(room.json.guestbook.map((g) => [g.name, Object.keys(g).sort().join()]), [['Third', 'at,id,name,text'], ['Visitor Yui', 'at,id,name,text']], 'newest first');
    assert.equal(room.json.visits, 2);
    for (const c of [owner, vis, third]) assert.ok(!room.text.includes(c.w.address), 'no wallet in the room');
    // the minute limit survives deleting the note
    const id = ok.json.entry.id;
    assert.equal((await third.call('DELETE', `/api/rooms/koenji-1/guestbook/${id}`)).status, 403, 'a stranger cannot delete');
    assert.equal((await vis.call('DELETE', `/api/rooms/koenji-3/guestbook/${id}`)).status, 404, 'wrong room');
    assert.equal((await vis.call('DELETE', `/api/rooms/koenji-1/guestbook/${id}`)).status, 200, 'the author can');
    assert.equal((await post(vis, 'sneaky repost')).status, 429);
    const thirds = (await anon.call('GET', '/api/rooms/koenji-1')).json.guestbook[0].id;
    assert.equal((await owner.call('DELETE', `/api/rooms/koenji-1/guestbook/${thirds}`)).status, 200, 'the owner can');
    assert.equal((await owner.call('DELETE', `/api/rooms/koenji-1/guestbook/${thirds}`)).status, 404);
    // 20 a day per wallet, whatever was deleted or pruned
    h.db.run('UPDATE guestbook_quota SET n = ?, last_at = 0 WHERE wallet = ? AND plot_id = ?', GUESTBOOK.perDay - 1, third.w.address, 'koenji-1');
    assert.equal((await post(third, 'the 20th today', 'koenji-2')).status, 200);
    const day = await post(third, 'over the limit', 'koenji-1');
    assert.equal(day.status, 429);
    assert.match(day.json.message, /20 notes a day/);
    assert.equal(h.db.get('SELECT day FROM guestbook_quota WHERE wallet = ?', third.w.address).day, utcDay());
    // only the latest 50 per room are kept
    for (let i = 0; i < 60; i++) h.db.run(`INSERT INTO guestbook (plot_id, wallet, text, created_at) VALUES ('koenji-3', ?, ?, ?)`, third.w.address, `n${i}`, Date.now());
    h.db.run('DELETE FROM guestbook_quota WHERE wallet = ?', owner.w.address);
    assert.equal((await post(owner, 'latest', 'koenji-3')).status, 200);
    room = await anon.call('GET', '/api/rooms/koenji-3');
    assert.equal(room.json.guestbook.length, 50);
    assert.equal(room.json.guestbook[0].text, 'latest');
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM guestbook WHERE plot_id = 'koenji-3'`).n, 50);
    // a new tenant does not inherit the old guestbook
    await resident(third, 'koenji-5', { name: 'Third' });
    await resident(vis, 'koenji-3', { name: 'Visitor Yui' });
    room = await anon.call('GET', '/api/rooms/koenji-3');
    assert.deepEqual([room.json.guestbook, room.json.visits], [[], 0]);
  } finally { h.close(); }
});

test('/api/world events: accepted, site_live, launched for public ideas only, first time each, last 24 h, newest first', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    const sub = await a.call('POST', '/api/ideas', IDEA(a.w, { title: 'Hidden Gem', tickerSuggestion: 'GEM', plotId: 'ueno-3' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'preview_ready');
    const anon = h.client(user(h.db));
    let w = await anon.call('GET', '/api/world');
    assert.deepEqual(w.json.events, [], 'a private idea makes no events');
    assert.ok(!w.text.includes('Hidden Gem') && !w.text.includes('GEM'));
    await a.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    // a regeneration passes preview_ready again: still one site_live
    transition(h.db, sub.json.id, 'preview_ready', 'generating');
    transition(h.db, sub.json.id, 'generating', 'preview_ready');
    w = await anon.call('GET', '/api/world');
    const p = h.db.get('SELECT name, ticker FROM projects WHERE idea_id = ?', sub.json.id);
    assert.deepEqual(w.json.events.map(({ at, ...e }) => e), [
      { kind: 'site_live', plotId: 'ueno-3', name: p.name, ticker: p.ticker },
      { kind: 'accepted', plotId: 'ueno-3', name: p.name, ticker: p.ticker }]);
    assert.ok(w.json.events[0].at >= w.json.events[1].at);
    assert.ok(!w.text.includes(a.w.address));
    // older than 24 h: gone
    h.db.run(`UPDATE events SET at = ? WHERE kind = 'status' AND idea_id = ?`, Date.now() - 86_400_000 - 1000, sub.json.id);
    assert.deepEqual(cityEvents(h.db), []);
    // launched (status event) on a public idea; at most 30
    h.db.run(`UPDATE ideas SET status = 'confirming' WHERE id = ?`, sub.json.id);
    transition(h.db, sub.json.id, 'confirming', 'launched');
    assert.deepEqual(cityEvents(h.db).map((e) => e.kind), ['launched']);
    for (let i = 0; i < 40; i++) h.db.run(`INSERT INTO events (at, actor, idea_id, kind, message, data_json, public) VALUES (?, 'system', ?, 'status', 'x', ?, 1)`,
      Date.now(), `idea_fake${i}`, JSON.stringify({ to: 'selected' }));
    assert.equal(cityEvents(h.db).length, 1, 'events of unknown ideas are ignored');
    for (let i = 0; i < 35; i++) {
      const vis = i % 5 ? 'public' : 'private';
      h.db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, 'selected', ?, 1, 1)`, `idea_many${i}`, a.w.address, vis);
      h.db.run(`INSERT INTO idea_versions (id, idea_id, version, title, concept, receiving_wallet, rights_confirmed, authored_by, content_hash, created_at)
        VALUES (?, ?, 1, ?, 'c', ?, 1, ?, 'h', 1)`, `v_many${i}`, `idea_many${i}`, `Many ${i}`, a.w.address, a.w.address);
      h.db.run(`INSERT INTO events (at, actor, idea_id, kind, message, data_json, public) VALUES (?, 'system', ?, 'status', 'x', ?, 1)`,
        Date.now(), `idea_many${i}`, JSON.stringify({ to: 'selected' }));
    }
    const many = cityEvents(h.db);
    assert.equal(many.length, 29, '28 public of the 35 + the launch');
    assert.ok(many.every((e) => !/^Many (0|5|10|15|20|25|30)$/.test(e.name)), 'private ones never');
    assert.deepEqual([many[0].name, many[0].ticker, many[0].plotId], ['Many 34', null, null], 'newest first; no ticker, no plot');
    for (let i = 35; i < 40; i++) {
      h.db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, 'selected', 'public', 1, 1)`, `idea_many${i}`, a.w.address);
      h.db.run(`INSERT INTO idea_versions (id, idea_id, version, title, concept, receiving_wallet, rights_confirmed, authored_by, content_hash, created_at)
        VALUES (?, ?, 1, ?, 'c', ?, 1, ?, 'h', 1)`, `v_many${i}`, `idea_many${i}`, `Many ${i}`, a.w.address, a.w.address);
      h.db.run(`INSERT INTO events (at, actor, idea_id, kind, message, data_json, public) VALUES (?, 'system', ?, 'status', 'x', ?, 1)`,
        Date.now(), `idea_many${i}`, JSON.stringify({ to: 'selected' }));
    }
    assert.equal(cityEvents(h.db).length, 30, 'at most 30');
  } finally { h.close(); }
});
