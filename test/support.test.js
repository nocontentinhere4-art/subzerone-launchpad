// Help / support (support.js, migration 022): strict reports, secrets scrubbed, the server's own DB context, per-IP and
// per-wallet limits, the author's view (wallet or read token), the admin routes, the operator's bearer inbox, and the
// owner's Telegram ping (mocked; never blocks, never logs the token).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, harness, wallet, user, logs } from './helpers.js';
import { openDb, migrate } from '../src/db.js';
import { scrubSecrets, validateReport, cleanClientContext, serverContext, createTicket, myTickets, replyTicket, listTickets, SUPPORT, SUPPORT_LABEL, operatorAllowed, notifyTelegram, parseSince } from '../src/support.js';
import { b58encode } from '../src/util.js';
import { randomBytes } from 'node:crypto';

const code = (fn) => { try { fn(); return null; } catch (e) { return [e.status, e.code]; } };
const REPORT = (extra = {}) => ({ category: 'launch', message: 'The launch button spins forever after I sign in Phantom.', ...extra });
const T0 = Date.parse('2026-10-12T10:00:00Z');
const OP = 'op_' + 'x'.repeat(40);
const SECRET_B58 = b58encode(randomBytes(64));                       // a 64-byte secret key, base58 (87–88 chars)
const BYTES = JSON.stringify([...randomBytes(64)]);                  // a keypair file
const TX_B64 = randomBytes(400).toString('base64');                  // a signed transaction
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('migration 022: support tables on a fresh database, applied once', () => {
  const db = openDb(':memory:');
  const applied = migrate(db);
  assert.ok(applied.includes('022_support.sql'));
  assert.ok(db.get(`SELECT 1 x FROM schema_migrations WHERE name = '022_support.sql'`));
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  for (const c of ['id', 'wallet', 'token_hash', 'ip_hash', 'category', 'source', 'message', 'contact', 'project_slug', 'client_context_json', 'server_context_json', 'redacted', 'status', 'created_at', 'updated_at']) assert.ok(cols('support_tickets').includes(c), c);
  assert.deepEqual(cols('support_replies'), ['id', 'ticket_id', 'author', 'text', 'created_at']);
  assert.deepEqual(migrate(db), [], 'nothing twice');
  assert.throws(() => db.run(`INSERT INTO support_tickets (id, token_hash, ip_hash, category, message, server_context_json, status, created_at, updated_at) VALUES ('sup_x', 'h', 'i', 'nope', 'm', '{}', 'open', 1, 1)`), /CHECK/);
});

test('support: strict validation of the report', () => {
  const bad = [null, [], 'text', { ...REPORT(), extra: 1 }, REPORT({ category: 'billing' }), REPORT({ category: undefined }), REPORT({ message: 'too short' }),
    REPORT({ message: '         short          ' }), REPORT({ message: 'x'.repeat(2001) }), REPORT({ message: 42 }), REPORT({ source: 'email' }),
    REPORT({ contact: '<script>alert(1)</script>' }), REPORT({ contact: 'x'.repeat(65) }), REPORT({ contact: 7 }), REPORT({ context: 'all of it' }), REPORT({ context: [1] })];
  for (const b of bad) assert.deepEqual(code(() => validateReport(b)), [400, 'bad_support'], JSON.stringify(b)?.slice(0, 80));
  const ok = validateReport(REPORT({ message: `  ${'Ab. '.repeat(500).trim()}. `, contact: '@sub01_fan', source: 'launch_error', context: null }));
  assert.equal(ok.message.length, 2000);
  assert.equal(validateReport(REPORT({ message: 'y'.repeat(100) })).redacted, true, 'one 100-letter run reads as a key: removed, flagged');
  assert.equal(ok.contact, '@sub01_fan');
  assert.equal(ok.source, 'launch_error');
  assert.equal(ok.context, null);
  for (const c of SUPPORT.categories) assert.equal(validateReport(REPORT({ category: c })).category, c);
  assert.equal(validateReport(REPORT({ contact: 't.me/someone' })).contact, 't.me/someone');
  assert.equal(validateReport(REPORT({ contact: '' })).contact, null);
});

test('support: secrets are scrubbed from the message and the context; wallets and words stay', () => {
  const addr = wallet().address;
  for (const s of [SECRET_B58, BYTES, TX_B64, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'Bearer abcdefghijklmnopqrstuvwxyz', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq',
    'private_key=5Jabcdefghijk', `my phrase is ${SEED}`, 'f'.repeat(64)]) {
    const out = scrubSecrets(`help ${s} please`);
    assert.equal(out.redacted, true, s.slice(0, 30));
    assert.ok(!out.text.includes(s.length > 20 ? s.slice(5, 25) : s), s.slice(0, 30));
  }
  const plain = `My wallet ${addr} shows "Transaction simulation failed: 0x1772". I tried twice with Phantom on my phone, it is not working at all.`;
  assert.deepEqual(scrubSecrets(plain), { text: plain, redacted: false });
  // a report with a pasted key: stored without it, flagged
  const r = validateReport(REPORT({ message: `here is my key ${SECRET_B58} can you check`, context: { launch: { message: `failed ${TX_B64}` } } }));
  assert.ok(!r.message.includes(SECRET_B58));
  assert.ok(r.message.includes('[removed'));
  assert.ok(!JSON.stringify(r.context).includes(TX_B64.slice(0, 40)));
  assert.equal(r.redacted, true);
});

test('support: the client context is an allow-list, capped and cleaned', () => {
  const addr = wallet().address;
  const { context, redacted } = cleanClientContext({
    wallet: addr, signedIn: true, project: { slug: 'ramen-radar', status: 'launch_prepared', evil: 'x' }, unknownThing: { secretKey: SECRET_B58 },
    launch: { intentId: 'li_abc', step: 'launch', status: 'failed', code: 'preflight_reject', message: 'Failed. '.repeat(120), httpStatus: 400, signedTx: TX_B64 },
    errors: Array.from({ length: 14 }, (_, i) => ({ at: T0 + i, method: 'POST', path: `/api/projects/x/launch/transaction?token=abc${i}`, status: 409, code: 'conflict', message: 'boom', body: 'x' })),
    wallets: ['Phantom', 'Solflare', { x: 1 }], bundle: 'index-abc123', userAgent: 'Mozilla/5.0 (X) '.repeat(40), viewport: '390x844@3', page: '#room/pc',
    privateKey: SECRET_B58, seed: SEED,
  });
  assert.equal(context.wallet, addr);
  assert.deepEqual(context.project, { slug: 'ramen-radar', status: 'launch_prepared' });
  assert.equal(context.launch.message.length, 300);
  assert.equal(context.launch.signedTx, undefined);
  assert.equal(context.errors.length, SUPPORT.errorsMax);
  assert.equal(context.errors[0].path, '/api/projects/x/launch/transaction');
  assert.equal(context.errors[0].body, undefined);
  assert.deepEqual(context.wallets, ['Phantom', 'Solflare']);
  assert.equal(context.userAgent.length, 300);
  const dump = JSON.stringify(context);
  for (const leak of [SECRET_B58, SEED, 'unknownThing', 'privateKey', 'token=abc']) assert.ok(!dump.includes(leak), leak);
  assert.equal(redacted, false, 'dropped fields are not "redacted": they were never read');
  assert.equal(cleanClientContext({ wallet: 'not-a-wallet', project: { slug: 'Bad Slug!' } }).context, null);
  assert.equal(cleanClientContext({ page: `#x ${SECRET_B58}` }).redacted, true);
});

function seedProject(db, owner, slug = 'ramen-radar') {
  const t = T0 - 60_000;
  db.run(`INSERT INTO ideas (id, owner_wallet, status, status_note, created_at, updated_at) VALUES (?, ?, 'launch_prepared', 'ready to sign', ?, ?)`, `idea_${slug}`, owner, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, 'Ramen Radar', 'RAMEN', 'd', ?, ?)`, `prj_${slug}`, `idea_${slug}`, slug, t, t);
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES (?, ?, 1, '[]', 10000, 'locked', ?)`, `fa_${slug}`, `prj_${slug}`, t);
  db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, mint_secret_enc, signer_wallet, status, tx_base64, error, created_at, updated_at)
    VALUES (?, ?, 'mock', 'devnet', '{}', 'h', ?, ?, 'ENCRYPTED-MINT-KEY', ?, 'failed', 'BASE64-UNSIGNED-TX', ?, ?, ?)`, `li_${slug}`, `prj_${slug}`, `fa_${slug}`, wallet().address, owner,
  `preflight: Transaction simulation failed: 0x1772 ${SECRET_B58}`, t, t + 1);
  db.run(`INSERT INTO jobs (id, type, idempotency_key, idea_id, project_id, status, attempts, max_attempts, timeout_ms, run_after, last_error, created_at, updated_at)
    VALUES (?, 'prepare_launch', ?, ?, ?, 'dead', 5, 5, 1000, 0, ?, ?, ?)`, `job_${slug}`, `k_${slug}`, `idea_${slug}`, `prj_${slug}`, 'RPC 429 '.repeat(100), t, t + 2);
  db.run(`INSERT INTO jobs (id, type, idempotency_key, idea_id, project_id, status, attempts, max_attempts, timeout_ms, run_after, created_at, updated_at)
    VALUES (?, 'generate', ?, ?, ?, 'succeeded', 1, 3, 1000, 0, ?, ?)`, `jobok_${slug}`, `kok_${slug}`, `idea_${slug}`, `prj_${slug}`, t, t);
}

test('support: the server attaches the DB state (launch intents, dead jobs), nothing secret', () => {
  const { db } = makeEnv();
  const owner = user(db).address;
  seedProject(db, owner);
  const c = serverContext(db, { wallet: owner });
  assert.equal(c.signedIn, true);
  assert.equal(c.ideas[0].status, 'launch_prepared');
  const p = c.projects[0];
  assert.equal(p.slug, 'ramen-radar');
  assert.equal(p.owned, true);
  assert.equal(p.intents[0].id, 'li_ramen-radar');
  assert.equal(p.intents[0].status, 'failed');
  assert.match(p.intents[0].error, /^preflight: Transaction simulation failed: 0x1772/);
  assert.deepEqual(c.jobs.map((j) => [j.id, j.status]), [['job_ramen-radar', 'dead']], 'only failing jobs');
  assert.equal(c.jobs[0].lastError.length, 300);
  const dump = JSON.stringify(c);
  for (const leak of [SECRET_B58, 'ENCRYPTED-MINT-KEY', 'BASE64-UNSIGNED-TX']) assert.ok(!dump.includes(leak), leak);
  // anonymous, naming a project: attached for the staff, marked as named by the client
  const anon = serverContext(db, { slug: 'ramen-radar' });
  assert.equal(anon.signedIn, false);
  assert.equal(anon.projects[0].namedByClient, true);
  assert.equal(anon.projects[0].owned, false);
  assert.equal(serverContext(db, { slug: 'nope' }).unknownSlug, 'nope');
  assert.deepEqual(serverContext(db, {}).projects, []);
});

test('support: 5 reports an hour per IP and per wallet, counted in the database', () => {
  const { db } = makeEnv();
  const w = user(db).address;
  for (let i = 0; i < SUPPORT.perHourIp; i++) createTicket(db, { body: REPORT(), ip: '203.0.113.7' }, T0 + i * 1000);
  const e = (() => { try { createTicket(db, { body: REPORT(), ip: '203.0.113.7' }, T0 + 10_000); } catch (x) { return x; } })();
  assert.deepEqual([e.status, e.code], [429, 'rate_limited']);
  assert.ok(e.extra.retryAfterS > 3500 && e.extra.retryAfterS <= 3600);
  assert.ok(createTicket(db, { body: REPORT(), ip: '203.0.113.7' }, T0 + 3_600_001).ticket.id, 'an hour later it is fine again');
  // per wallet, across IPs
  for (let i = 0; i < SUPPORT.perHourWallet; i++) createTicket(db, { body: REPORT(), wallet: w, ip: `198.51.100.${i}` }, T0 + i);
  assert.deepEqual(code(() => createTicket(db, { body: REPORT(), wallet: w, ip: '198.51.100.99' }, T0 + 100)), [429, 'rate_limited']);
  assert.ok(createTicket(db, { body: REPORT(), ip: '198.51.100.99' }, T0 + 100).ticket.id, 'the same IP anonymously still has room');
  // the IP itself is never stored
  assert.ok(!JSON.stringify(db.all('SELECT * FROM support_tickets')).includes('203.0.113.7'));
  // and the global cap
  const { db: db2 } = makeEnv();
  for (let i = 0; i < SUPPORT.perHourAll; i++) createTicket(db2, { body: REPORT(), ip: `10.0.${i >> 8}.${i & 255}` }, T0 + i);
  assert.deepEqual(code(() => createTicket(db2, { body: REPORT(), ip: '10.9.9.9' }, T0 + 500)), [429, 'rate_limited']);
});

test('support: the author reads by wallet or read token; nobody else does; no context comes back', () => {
  const { db } = makeEnv();
  const a = user(db).address, b = user(db).address;
  const anon = createTicket(db, { body: REPORT({ context: { userAgent: 'UA', launch: { message: 'x' } } }), ip: '1.1.1.1' }, T0);
  const mine = createTicket(db, { body: REPORT({ category: 'wallet' }), wallet: a, ip: '1.1.1.2' }, T0 + 1);
  assert.match(anon.token, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(code(() => myTickets(db, {})), [401, 'sign_in']);
  assert.deepEqual(code(() => myTickets(db, { tokens: ['short', '../etc'] })), [401, 'sign_in']);
  assert.deepEqual(myTickets(db, { tokens: [anon.token] }).tickets.map((t) => t.id), [anon.ticket.id]);
  assert.deepEqual(myTickets(db, { wallet: a }).tickets.map((t) => t.id), [mine.ticket.id]);
  assert.deepEqual(myTickets(db, { wallet: a, tokens: [anon.token] }).tickets.map((t) => t.id), [mine.ticket.id, anon.ticket.id]);
  assert.deepEqual(myTickets(db, { wallet: b }).tickets, []);
  assert.deepEqual(myTickets(db, { tokens: ['A'.repeat(32)] }).tickets, []);
  const view = myTickets(db, { tokens: [anon.token] }).tickets[0];
  assert.deepEqual(Object.keys(view).sort(), ['category', 'createdAt', 'id', 'message', 'replies', 'status', 'updatedAt']);
  replyTicket(db, anon.ticket.id, { text: 'Fixed: try again now.' }, 'operator', T0 + 5);
  const after = myTickets(db, { tokens: [anon.token] }).tickets[0];
  assert.equal(after.status, 'answered');
  assert.deepEqual(after.replies, [{ from: SUPPORT_LABEL, text: 'Fixed: try again now.', at: T0 + 5 }]);
});

test('support: staff list filters, newest first, open count; replies and statuses are validated', () => {
  const { db } = makeEnv();
  const t1 = createTicket(db, { body: REPORT({ category: 'site', message: 'My site shows a blank page on Safari.' }), ip: '1' }, T0).ticket;
  const t2 = createTicket(db, { body: REPORT({ category: 'x' }), ip: '2' }, T0 + 1).ticket;
  createTicket(db, { body: REPORT(), ip: '3' }, T0 + 2);
  const all = listTickets(db);
  assert.equal(all.tickets.length, 3);
  assert.equal(all.tickets[2].id, t1.id, 'newest first');
  assert.equal(all.open, 3);
  assert.deepEqual(listTickets(db, { category: 'site' }).tickets.map((t) => t.id), [t1.id]);
  assert.deepEqual(listTickets(db, { q: 'Safari' }).tickets.map((t) => t.id), [t1.id]);
  assert.deepEqual(listTickets(db, { q: '%' }).tickets, [], 'LIKE wildcards are literal');
  replyTicket(db, t2.id, { text: 'Looking into it', status: 'in_progress' }, 'admin:x', T0 + 10);
  replyTicket(db, t1.id, { text: 'Done' }, 'operator', T0 + 11);
  assert.deepEqual(listTickets(db, { status: 'answered' }).tickets.map((t) => t.id), [t1.id]);
  assert.equal(listTickets(db).open, 2, 'open + in progress');
  assert.deepEqual(listTickets(db, { since: T0 + 10 }).tickets.map((t) => t.id), [t1.id]);
  for (const b of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 'ok', status: 'resolved' }, {}]) assert.deepEqual(code(() => replyTicket(db, t1.id, b, 'operator')), [400, 'bad_support']);
  assert.deepEqual(code(() => replyTicket(db, 'sup_nothere', { text: 'x' }, 'operator')), [404, 'not_found']);
  assert.deepEqual(code(() => listTickets(db, { status: 'bogus' })), [400, 'bad_support']);
  assert.equal(parseSince('1760263200000'), 1760263200000);
  assert.equal(parseSince('2026-10-12T10:00:00Z'), T0);
  assert.equal(parseSince(null), null);
  assert.deepEqual(code(() => parseSince('yesterday')), [400, 'bad_support']);
});

test('support: operator token compare (constant time, exact)', () => {
  const cfg = { support: { operatorToken: OP } };
  assert.equal(operatorAllowed(cfg, `Bearer ${OP}`), true);
  for (const h of [undefined, '', OP, `Bearer ${OP}x`, `Bearer ${OP.slice(0, -1)}`, `bearer ${OP}`, `Bearer  ${OP}`, `Basic ${OP}`]) assert.equal(operatorAllowed(cfg, h), false, String(h));
  assert.equal(operatorAllowed({ support: { operatorToken: '' } }, 'Bearer '), false);
});

test('support over HTTP: anonymous and signed-in reports, "My reports", admin routes', async (t) => {
  const admin = wallet();
  const h = await harness({ ADMIN_WALLETS: admin.address });
  t.after(() => h.close());
  const anon = h.client(wallet()), alice = h.client(wallet()), boss = h.client(admin);
  await alice.signIn(); await boss.signIn();

  const r1 = await anon.call('POST', '/api/support', REPORT({ source: 'help', contact: '@anon', context: { userAgent: 'UA', privateKey: SECRET_B58 } }));
  assert.equal(r1.status, 200);
  assert.match(r1.json.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(r1.json.ticket.status, 'open');
  const r2 = await alice.call('POST', '/api/support', REPORT({ category: 'devbuy', message: 'Dev buy failed: price moved more than 5%.' }));
  assert.equal(r2.status, 200);
  assert.equal(h.db.get('SELECT wallet FROM support_tickets WHERE id = ?', r2.json.ticket.id).wallet, alice.w.address);
  assert.equal((await anon.call('POST', '/api/support', { category: 'launch', message: 'short' })).status, 400);
  assert.equal((await anon.call('POST', '/api/support', REPORT(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await anon.call('POST', '/api/support', { ...REPORT(), message: 'x'.repeat(20_000) })).status, 413);

  // my reports: the token header, or the session
  assert.equal((await anon.call('GET', '/api/support/mine')).status, 401);
  const m1 = await anon.call('GET', '/api/support/mine', undefined, { 'x-support-token': r1.json.token });
  assert.deepEqual(m1.json.tickets.map((x) => x.id), [r1.json.ticket.id]);
  assert.ok(!m1.text.includes('UA') && !m1.text.includes('serverContext'), 'no context back to the author');
  assert.deepEqual((await alice.call('GET', '/api/support/mine')).json.tickets.map((x) => x.id), [r2.json.ticket.id]);

  // admin: list, reply, status; a plain user and a stranger are refused
  assert.equal((await anon.call('GET', '/api/admin/support')).status, 401);
  assert.equal((await alice.call('GET', '/api/admin/support')).status, 403);
  assert.equal((await alice.call('POST', `/api/admin/support/${r1.json.ticket.id}/reply`, { text: 'hi' })).status, 403);
  const list = await boss.call('GET', '/api/admin/support');
  assert.equal(list.status, 200);
  assert.equal(list.json.open, 2);
  assert.deepEqual(list.json.tickets.map((x) => x.id), [r2.json.ticket.id, r1.json.ticket.id]);
  const st = list.json.tickets[1];
  assert.equal(st.contact, '@anon');
  assert.equal(st.clientContext.userAgent, 'UA');
  assert.ok(!JSON.stringify(st).includes(SECRET_B58));
  assert.equal(st.serverContext.signedIn, false);
  const rep = await boss.call('POST', `/api/admin/support/${r1.json.ticket.id}/reply`, { text: 'We restarted the launch job. Try again.' });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.replies[0].author, `admin:${admin.address}`);
  const seen = await anon.call('GET', '/api/support/mine', undefined, { 'x-support-token': r1.json.token });
  assert.deepEqual(seen.json.tickets[0].replies.map((x) => [x.from, x.text]), [[SUPPORT_LABEL, 'We restarted the launch job. Try again.']]);
  assert.ok(!seen.text.includes(admin.address), 'the author does not see who answered');
  assert.equal((await boss.call('POST', `/api/admin/support/${r1.json.ticket.id}/status`, { status: 'closed' })).json.status, 'closed');
  assert.equal((await boss.call('POST', `/api/admin/support/${r1.json.ticket.id}/status`, { status: 'gone' })).status, 400);
  assert.equal((await boss.call('GET', '/api/admin/support?status=open')).json.tickets.length, 1);
  // the operator's routes do not exist without SUPPORT_OPERATOR_TOKEN
  const bare = (path, init = {}) => fetch(h.base + path, init);
  assert.equal((await bare('/api/support/inbox', { headers: { authorization: `Bearer ${OP}` } })).status, 404);
  assert.equal((await bare(`/api/support/${r1.json.ticket.id}/reply`, { method: 'POST', headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 404);
  assert.equal((await bare(`/api/support/${r1.json.ticket.id}`, { headers: { authorization: `Bearer ${OP}` } })).status, 404);
});

test('support over HTTP: the operator inbox, reply and status with a bearer token (no cookie, no Origin)', async (t) => {
  const admin = wallet();
  const h = await harness({ ADMIN_WALLETS: admin.address, SUPPORT_OPERATOR_TOKEN: OP });
  t.after(() => h.close());
  const anon = h.client(wallet()), boss = h.client(admin);
  await boss.signIn();
  const r1 = await anon.call('POST', '/api/support', REPORT({ source: 'launch_error', context: { launch: { step: 'launch', code: 'preflight_reject', message: 'simulation failed' } } }));
  const op = (path, init = {}) => fetch(h.base + path, { ...init, headers: { authorization: `Bearer ${OP}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  const noAuth = await fetch(`${h.base}/api/support/inbox`);
  assert.equal(noAuth.status, 401);
  assert.equal((await fetch(`${h.base}/api/support/inbox`, { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } })).status, 401);
  assert.equal((await boss.call('GET', '/api/support/inbox')).status, 401, 'an admin session is not the operator');
  const inbox = await op('/api/support/inbox?since=0');
  assert.equal(inbox.status, 200);
  const box = await inbox.json();
  assert.equal(box.tickets.length, 1);
  assert.equal(box.tickets[0].clientContext.launch.code, 'preflight_reject');
  assert.equal(box.tickets[0].source, 'launch_error');
  assert.equal(typeof box.now, 'number');
  assert.equal((await (await op(`/api/support/inbox?since=${box.now}`)).json()).tickets.length, 0, 'since: only what changed');
  assert.equal((await op('/api/support/inbox?since=soon')).status, 400);
  assert.equal((await op(`/api/support/${r1.json.ticket.id}`)).status, 200);
  assert.equal((await op('/api/support/sup_missing123')).status, 404);
  // POST without an Origin header: allowed with the bearer token, refused without it
  const reply = await op(`/api/support/${r1.json.ticket.id}/reply`, { method: 'POST', body: JSON.stringify({ text: 'Your launch failed the simulation; retry from the PC.', status: 'answered' }) });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).replies[0].author, 'operator');
  assert.equal((await fetch(`${h.base}/api/support/${r1.json.ticket.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 403);
  assert.equal((await fetch(`${h.base}/api/support/${r1.json.ticket.id}/reply`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope', 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 401);
  const status = await op(`/api/support/${r1.json.ticket.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) });
  assert.equal((await status.json()).status, 'closed');
  const mine = await anon.call('GET', '/api/support/mine', undefined, { 'x-support-token': r1.json.token });
  assert.equal(mine.json.tickets[0].status, 'closed');
  assert.deepEqual(mine.json.tickets[0].replies.map((x) => x.from), ['SUBZERONE support']);
  assert.ok(!logs.some((l) => l.includes(OP)), 'the operator token is never logged');
});

test('support: the owner Telegram ping is fire and forget, never logs the token, skipped when unset', async (t) => {
  const BOT = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq';
  const calls = [];
  let hang = true;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org/')) { calls.push({ url: String(url), body: JSON.parse(init.body) }); if (hang) return new Promise(() => {}); throw new TypeError(`fetch failed ${url}`); }
    return new Response('{}', { status: 500 });
  };
  const h = await harness({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '-1001234567890' }, { fetchImpl });
  t.after(() => h.close());
  const c = h.client(wallet());
  const long = `Phantom says the transaction is unsafe and will not sign it. ${'More detail here. '.repeat(20)}`;
  const started = Date.now();
  const r = await c.call('POST', '/api/support', REPORT({ category: 'wallet', message: long }));
  assert.equal(r.status, 200, 'a hanging Telegram never holds the report');
  assert.ok(Date.now() - started < 3000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${BOT}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '-1001234567890');
  const lines = calls[0].body.text.split('\n');
  assert.equal(lines[0], 'SUBZERONE support · Wallet/Phantom · anonymous');
  assert.equal(lines[1], `${long.replace(/\s+/g, ' ').slice(0, 200)}…`);
  assert.equal(lines[2], 'http://localhost:8787/admin#support');
  // a failing Telegram: still 200, a warning without the token or the URL
  hang = false;
  const before = logs.length;
  assert.equal((await c.call('POST', '/api/support', REPORT())).status, 200);
  await new Promise((res) => setTimeout(res, 50));
  const warn = logs.slice(before).find((l) => l.includes('support telegram not sent'));
  assert.ok(warn, 'logged');
  assert.ok(!logs.some((l) => l.includes(BOT) || l.includes('AAHdqTcv')), 'the bot token is never logged');
  // unset: no call
  const calls2 = [];
  const off = await harness({}, { fetchImpl: async (url) => { calls2.push(url); return new Response('{}'); } });
  t.after(() => off.close());
  assert.equal((await off.client(wallet()).call('POST', '/api/support', REPORT())).status, 200);
  assert.equal(calls2.filter((u) => String(u).includes('telegram')).length, 0);
  // and the helper alone: null when unset, false on a non-2xx answer
  assert.equal(notifyTelegram({ support: {} }, () => { throw new Error('no'); }, { id: 'x', category: 'x', message: 'm' }), null);
  assert.equal(await notifyTelegram({ publicOrigin: 'http://x', support: { telegramBotToken: BOT, telegramChatId: '1' } }, async () => new Response('', { status: 401 }), { id: 'x', category: 'other', message: 'm' }), false);
  assert.equal(await notifyTelegram({ publicOrigin: 'http://x', support: { telegramBotToken: BOT, telegramChatId: '1' } }, () => { throw new Error(BOT); }, { id: 'x', category: 'other', message: 'm' }), false);
  assert.ok(!logs.some((l) => l.includes(BOT)));
});

test('support: a weak operator token keeps the inbox off', async (t) => {
  const h = await harness({ SUPPORT_OPERATOR_TOKEN: 'short' });
  t.after(() => h.close());
  assert.equal(h.cfg.support.operatorToken, '');
  assert.equal((await fetch(`${h.base}/api/support/inbox`, { headers: { authorization: 'Bearer short' } })).status, 404);
});
