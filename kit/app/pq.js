// The app's post-quantum block (docs/APP-COMPOSER.md, block `pq`): the coin's signed registry, verified HERE, in the
// visitor's browser, with ML-DSA-65 from @noble/post-quantum (MIT, vendored at /_kit/vendor/, loaded on first use);
// a "verify anything" box; and a plain-words box on what is and is not quantum-safe. Read-only: no wallet, no
// transaction, no upload. Text reaches the page through textContent only.
export const WINTERNITZ = 'https://github.com/blueshift-gg/solana-winternitz-vault';
const HEADER = 'SUBZERONE post-quantum registry v1';
const enc = new TextEncoder();
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fromB64 = (s) => Uint8Array.from(atob(String(s).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const fromHex = (s) => { const x = String(s).replace(/\s+|^0x/g, ''); if (!/^([0-9a-f]{2})+$/i.test(x)) throw new Error('not hex'); return Uint8Array.from(x.match(/../g), (b) => parseInt(b, 16)); };
const bytes = (s) => { const t = String(s).trim(); try { return /^[0-9a-f\s]+$/i.test(t) && t.replace(/\s+/g, '').length % 2 === 0 ? fromHex(t) : fromB64(t); } catch { throw new Error('use base64 or hex'); } };
const message = (e, slug, payloadHash, prev) => [HEADER, `project: ${slug}`, `seq: ${e.seq}`, `kind: ${e.kind}`, `ref: ${e.ref}`, `at: ${new Date(e.at).toISOString()}`, `payload-sha256: ${payloadHash}`, `prev: ${prev}`].join('\n');
const KIND = { 'registry.key': 'Registry key created', 'fees.split': 'Fee split approved', 'launch.config': 'Launch configuration', 'launch.mint': 'Mint verified on chain',
  'site.version': 'Website version built', 'app.reveal': 'App reveal', 'owner.note': 'Note from the author', 'child.launch': 'Coin launched from this site' };

/** Verify one page of entries (newest first). -> [{seq, sig, payload, link}] each true/false/null (null: cannot tell from this page). */
export async function verifyEntries(ml, data, entries) {
  const pub = fromB64(data.publicKey), out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], older = entries[i + 1];
    const ph = await sha256hex(e.payload);
    const prevLine = /\nprev: (\S+)$/.exec(e.message)?.[1] || '';
    const rebuilt = message(e, data.project, ph, prevLine);
    const link = e.seq === 1 ? prevLine === 'genesis' : older && older.seq === e.seq - 1 ? prevLine === await sha256hex(older.message) : null;
    let sig = false;
    try { sig = ml.verify(fromB64(e.signature), enc.encode(e.message), pub); } catch { sig = false; }
    out.push({ seq: e.seq, sig, payload: rebuilt === e.message, link });
  }
  return out;
}

export function pqBlock(slot, b, K) {
  const { h, api, vendor, msg, say, busy } = K;
  const put = (el, text, kind = '') => { el.textContent = text; el.className = `pq-sum${kind ? ` ${kind}` : ''}`; };
  const kids = [];
  let data = null, ml = null;
  const lib = () => (ml ? Promise.resolve(ml) : vendor('pq').then((m) => (ml = m.ml_dsa65)));
  if (b.registry) {
    const head = h('p', { cls: 'fine', text: 'Loading the registry…' }), list = h('ol', { cls: 'pq-list', reversed: true }), sum = h('p', { cls: 'pq-sum', role: 'status' });
    const keyBox = h('details', { cls: 'pq-key' }, h('summary', { text: 'Public key (ML-DSA-65, 1952 bytes, base64)' }), h('code', { cls: 'pq-code' }));
    const more = h('button', { cls: 'btn btn-ghost btn-sm', type: 'button', text: 'Older entries', hidden: true });
    const all = [];
    const draw = async (page) => {
      all.push(...page.entries);
      const m = await lib();
      const res = await verifyEntries(m, data, all);
      list.replaceChildren(...all.map((e, i) => {
        const r = res[i], ok = r.sig && r.payload && r.link !== false;
        let payload = {}; try { payload = JSON.parse(e.payload); } catch { /* shown raw */ }
        const line = e.kind === 'site.version' ? `version ${payload.version} · html sha256 ${String(payload.htmlSha256).slice(0, 16)}…` : e.kind === 'launch.mint' ? `${payload.mint} on ${payload.network}`
          : e.kind === 'fees.split' ? (payload.recipients || []).map((x) => `${x.label} ${x.bps / 100}%`).join(' · ') : e.kind === 'launch.config' ? `${payload.provider} · ${payload.network} · config sha256 ${String(payload.configSha256).slice(0, 16)}…`
          : e.kind === 'child.launch' ? `${payload.name} ($${payload.ticker}) · ${payload.mint} on ${payload.network} · split ${(payload.split || []).map((x) => `${x.role === 'submitter' ? 'creator' : x.role} ${x.bps / 100}%`).join(' / ')}${payload.locked ? ' (locked)' : ''} · config sha256 ${String(payload.configSha256).slice(0, 16)}…`
          : e.kind === 'owner.note' ? payload.text : e.kind === 'app.reveal' ? `#${payload.number ?? '—'} chosen by ${payload.method}${payload.dev ? ' (dev trigger)' : ''}` : e.kind === 'registry.key' ? `${payload.alg} key for ${payload.project}` : e.ref;
        return h('li', { cls: `pq-e ${ok ? 'ok' : 'bad'}`, value: e.seq },
          h('span', { cls: 'pq-v', text: ok ? 'verified ✓' : 'failed ✗', title: `signature ${r.sig ? 'ok' : 'BAD'} · payload hash ${r.payload ? 'ok' : 'BAD'} · chain link ${r.link == null ? 'checked with the next page' : r.link ? 'ok' : 'BAD'}` }),
          h('strong', { text: `#${e.seq} ${KIND[e.kind] || e.kind}` }), h('span', { cls: 'fine', text: ` · ${new Date(e.at).toLocaleString()}` }),
          h('div', { cls: 'pq-line', text: line }),
          h('details', {}, h('summary', { text: 'What was signed' }), h('pre', { cls: 'pq-code', text: e.message }), h('div', { cls: 'fine', text: `payload: ${e.payload}` }), h('div', { cls: 'pq-code fine', text: `signature (${fromB64(e.signature).length} bytes): ${e.signature.slice(0, 96)}…` })));
      }));
      const good = res.filter((r) => r.sig && r.payload && r.link !== false).length;
      put(sum, `${good} of ${res.length} entries verified in your browser (ML-DSA-65, FIPS 204, @noble/post-quantum).${data.total > all.length ? ` ${data.total - all.length} older ones on the next page.` : ''}`, good === res.length ? 'ok' : 'err');
      more.hidden = !page.next; more.onclick = () => busy(more, async () => draw(await api(`/_api/app/pq?before=${page.next}`)));
    };
    (async () => {
      try {
        data = await api('/_api/app/pq');
        keyBox.querySelector('code').textContent = data.publicKey;
        head.textContent = `${data.total} signed entr${data.total === 1 ? 'y' : 'ies'}. The server signs each one with this coin's own post-quantum key; your browser checks every signature, every payload hash and every link of the chain.`;
        put(sum, 'Loading the verifier (@noble/post-quantum)…');
        await draw(data);
      } catch (e) { head.textContent = `The registry could not load (${e.message}).`; }
    })();
    kids.push(head, sum, list, more, keyBox);
  }
  if (b.verify) {
    const m = h('textarea', { rows: 3, placeholder: 'The message (exact text)', 'aria-label': 'Message' });
    const s = h('textarea', { rows: 2, placeholder: 'ML-DSA-65 signature (base64 or hex)', 'aria-label': 'Signature' });
    const k = h('textarea', { rows: 2, placeholder: "Public key (base64 or hex). Empty = this coin's key", 'aria-label': 'Public key' });
    const out = msg();
    const go = h('button', { cls: 'btn', type: 'button', text: 'Verify here', onclick: () => busy(go, async () => {
      try {
        const lib2 = await lib();
        const pub = k.value.trim() ? bytes(k.value) : data ? fromB64(data.publicKey) : null;
        if (!pub) throw new Error('paste a public key');
        if (pub.length !== 1952) throw new Error(`an ML-DSA-65 public key is 1952 bytes; this one is ${pub.length}`);
        const sig = bytes(s.value);
        say(out, lib2.verify(sig, enc.encode(m.value), pub) ? 'Valid: this key signed exactly this message. ✓' : 'Not valid for this message and key. ✗', lib2.verify(sig, enc.encode(m.value), pub) ? 'ok' : 'err');
      } catch (e) { say(out, e.message || 'Could not verify.', 'err'); }
    }) });
    kids.push(h('div', { cls: 'pq-verify' }, h('h4', { text: 'Verify anything' }), h('p', { cls: 'fine', text: 'Paste a message, an ML-DSA-65 signature and a public key: the check runs in this page, nothing is sent anywhere.' }), m, s, k, h('div', { cls: 'row' }, go), out));
  }
  if (b.honesty) {
    kids.push(h('div', { cls: 'pq-honest' }, h('h4', { text: 'What is and is not quantum-safe here' }),
      h('p', { text: 'Solana accounts, this coin and every wallet that holds it use Ed25519 signatures. A large enough quantum computer could break Ed25519. This site does not change that: the coin itself is not quantum-proof, and nobody can make it so from a web page.' }),
      h('p', { text: 'What this page gives you is a quantum-safe, tamper-evident record of everything the launchpad did for this coin: each step is hashed, chained to the one before and signed with ML-DSA-65 (FIPS 204), a post-quantum signature, and your browser checks it.' }),
      // a launchpad (child-launch.js): the registry of every launch, the coins' Ed25519, and one line on fee vaults
      ...(K.launches ? [h('p', { text: 'The coins launched from this site are Solana tokens too: none of them is quantum-proof either. What is post-quantum is this record: every launch from here (its configuration hash, its locked fee split, its mint and its transaction) is signed into it, and your browser checks it.' }),
        h('p', { text: 'A quantum-resistant vault for creator fees is not available on Solana mainnet today.' })]
        : [h('p', {}, 'Further reading: quantum-resistant vaults on Solana use one-time Winternitz signatures, see the open-source ', h('a', { href: WINTERNITZ, target: '_blank', rel: 'noopener noreferrer nofollow', text: 'Solana Winternitz vault' }), '. Read-only reading: this site never asks for a transaction.')])));
  }
  slot.replaceChildren(...kids);
}
