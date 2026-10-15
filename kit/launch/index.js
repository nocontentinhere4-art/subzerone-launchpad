// The launch block (docs/APP-COMPOSER.md, "The launch block"; server: src/child-launch.js): visitors launch a REAL coin
// from this site. Built by kit/build.mjs into /_kit/site-launch.v1.js, loaded by the app module only on a site whose
// app has a launch block. The one kit module that asks a wallet to sign a TRANSACTION, and only after the visitor has
// reviewed it here: the server builds it (the launchpad's pump.fun provider), checks the signed copy is the reviewed
// one and broadcasts it; this file never builds, changes or sends a transaction. Same rules as the rest of the kit:
// text only (textContent and attribute setters, no HTML sinks), same-origin /_api/launch* without credentials.
// Wallets: the Wallet Standard (solana:signMessage + solana:signTransaction); legacy injected providers are not used here.

const b58a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b); let o = ''; while (n > 0n) { o = b58a[Number(n % 58n)] + o; n /= 58n; } for (const b of bytes) { if (b === 0) o = `1${o}`; else break; } return o; }
const u8 = (x) => (x instanceof Uint8Array ? x : x?.buffer instanceof ArrayBuffer ? new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength) : Array.isArray(x) ? Uint8Array.from(x) : null);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const sol = (l) => (l == null ? '—' : `${(Number(l) / 1e9).toFixed(9).replace(/\.?0+$/, '')} SOL`);
const short = (w) => (w && w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w || '');
const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
const usd = (n) => (typeof n !== 'number' ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);
const ROLE = { submitter: 'you (the creator)', parent: "this site's author", sub01: 'SUB-01' };   // grandparent: its label ("Author of …")
const STEPS = [['submitted', 'Sent'], ['evaluating', "SUB-01's vote"], ['generating', 'Site built'], ['launch_prepared', 'Launch reviewed'], ['awaiting_signature', 'Signed'], ['confirming', 'On-chain'], ['launched', 'Launched']];
const ORDER = { submitted: 0, evaluating: 1, selected: 2, generating: 2, preview_ready: 2, approved: 3, launch_prepared: 3, awaiting_signature: 4, confirming: 5, launched: 6 };
const DONE = new Set(['launched', 'declined', 'cancelled', 'failed']);

// --- wallets ---------------------------------------------------------------------------------------------------------
const wallets = new Map();
const usable = (w) => (w?.chains || []).some((c) => String(c).startsWith('solana:')) && typeof w.features?.['standard:connect']?.connect === 'function'
  && typeof w.features?.['solana:signMessage']?.signMessage === 'function' && typeof w.features?.['solana:signTransaction']?.signTransaction === 'function';
const registerApi = Object.freeze({ register: (...list) => { for (const w of list) if (usable(w)) wallets.set(w.name, w); return () => {}; } });
addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registerApi); } catch { /* a bad wallet */ } });
try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registerApi })); } catch { /* old browser */ }
let current = null;                                          // {wallet, account}

export function launchBlock(slot, b, K) {
  const { h, api, msg, say, busy, explain, store, slideIn } = K;
  const doc = document;
  const keyOf = (id) => `kit.launch.${location.host}.${id}`;
  const LAST = `kit.launch.${location.host}.last`;
  let parent = null;

  function pickWallet() {
    const list = [...wallets.values()];
    if (current && list.includes(current.wallet)) return Promise.resolve(current.wallet);
    if (!list.length) return Promise.reject(new Error('No Solana wallet that can sign transactions was found in this browser (Wallet Standard: Phantom, Solflare, Backpack). Install one, or open this page in your wallet app.'));
    if (list.length === 1) return Promise.resolve(list[0]);
    return new Promise((resolve, reject) => {
      const close = (w, err) => { box.remove(); if (err) reject(err); else resolve(w); };
      const box = h('div', { cls: 'picker', role: 'dialog', 'aria-label': 'Pick a wallet', onclick: (e) => { if (e.target === box) close(null, new Error('No wallet picked. Nothing was signed.')); } },
        h('div', { cls: 'card' }, h('span', { cls: 'eyebrow', text: 'Launch with' }), list.map((w) => h('button', { cls: 'btn btn-ghost', type: 'button', text: w.name, onclick: () => close(w) }))));
      doc.body.append(box);
    });
  }
  async function connect() {
    const w = await pickWallet();
    if (current?.wallet === w) return current;
    const res = await w.features['standard:connect'].connect();
    const account = res?.accounts?.[0] || w.accounts?.[0];
    if (!account?.address) throw new Error('The wallet shared no account. Unlock it and try again.');
    current = { wallet: w, account };
    return current;
  }
  async function signText(text) {
    const { wallet, account } = await connect();
    const out = await wallet.features['solana:signMessage'].signMessage({ account, message: new TextEncoder().encode(text) });
    const sig = u8((Array.isArray(out) ? out[0] : out)?.signature);
    if (!sig || sig.length !== 64) throw new Error('The wallet answered without a valid signature.');
    return b58(sig);
  }
  async function signTx(txBase64, network) {
    const { wallet, account } = await connect();
    const chain = network === 'mainnet-beta' ? 'solana:mainnet' : `solana:${network}`;
    const [res] = await wallet.features['solana:signTransaction'].signTransaction({ account, transaction: fromB64(txBase64), chain });
    const signed = u8(res?.signedTransaction);
    if (!signed) throw new Error('The wallet answered without a signed transaction.');
    return toB64(signed);
  }

  // --- parts of the block --------------------------------------------------------------------------------------------
  const head = h('div', { cls: 'ln-head' }), list = h('ul', { cls: 'ln-kids' }), live = h('div', { cls: 'ln-live' }), form = h('div', { cls: 'ln-form' });
  const splitRows = (rows) => h('table', { cls: 'ln-split' }, h('tbody', {}, ...rows.map((r) => h('tr', {},
    h('td', { text: pct(r.bps) }), h('td', { text: ROLE[r.role] || (r.role === 'grandparent' ? `${r.label} (the launchpad above)` : r.label) }), h('td', {}, h('code', { text: r.wallet ? short(r.wallet) : 'your wallet', title: r.wallet || '' }))))));

  // a launchpad family (family.js): what a coin launched here is, and the split it gets (the grandparent from generation 2)
  const pads = () => parent.childrenMode === 'launchpads' && parent.childCanBeLaunchpad;
  function familyLine() {
    const f = parent.familySplit || { ...parent.split, grandparent: 0 }, gp = parent.ancestors?.[0];
    const split = `${pct(f.creator)} to its creator, ${pct(f.parent)} to this site's author, ${f.grandparent ? `${pct(f.grandparent)} to the author of ${gp ? gp.name : 'the launchpad above this one'}, ` : ''}${pct(f.sub01)} to SUB-01`;
    const what = parent.childrenMode === 'coins' || !parent.children ? ''
      : !parent.childCanBeLaunchpad ? ` This site is at generation ${parent.depth} of at most ${parent.maxDepth}: what launches here is a coin, not a launchpad.`
      : parent.childrenMode === 'launchpads' ? ` Every coin launched here is a launchpad too, with its own site that launches coins (generation ${parent.childDepth} of at most ${parent.maxDepth}).`
      : ` You choose: a coin, or a launchpad with its own site that launches coins (generation ${parent.childDepth} of at most ${parent.maxDepth}).`;
    return `Creator fees of every coin launched here, split on-chain and locked: ${split}.${what}${parent.childrenMode && parent.childrenMode !== 'coins' ? ' The fees go to the creators of the launchpads up the family tree, never to buyers or holders.' : ''}`;
  }
  function drawParent() {
    const c = parent.counts, net = parent.provider ? (parent.provider.mock ? 'MOCK provider: rehearsal, no blockchain' : `pump.fun · Solana ${parent.provider.network}`) : 'launching is off';
    const noun = pads() ? ['launchpad launched here', 'launchpads launched here'] : ['coin launched here', 'coins launched here'];
    head.replaceChildren(
      h('div', { cls: 'app-tiles' }, ...[[c.launched, c.launched === 1 ? noun[0] : noun[1]], [c.inProgress, 'on their way'], [usd(c.volume24hUsd), '24h volume'], [usd(c.marketCapUsd), 'market cap']]
        .map(([v, l]) => h('div', { cls: 'app-tile' }, h('span', { cls: 'app-n', text: String(v) }), h('span', { cls: 'fine', text: l })))),
      h('p', { cls: 'fine', text: `${net}. ${familyLine()}` }));
    if (b.list) {
      list.replaceChildren(...(parent.children.length ? parent.children.map((k) => h('li', {},
        k.logoUrl ? h('img', { src: k.logoUrl, alt: '', width: 40, height: 40, loading: 'lazy' }) : h('span', { cls: 'ln-dot' }),
        h('div', {}, h('a', { href: k.siteUrl, target: '_blank', rel: 'noopener noreferrer', text: `${k.name} $${k.ticker}` }), k.launchpad ? h('span', { cls: 'ln-badge', text: 'launchpad' }) : null,
          h('small', { text: [k.mock ? 'MOCK' : k.network, short(k.mint), k.marketCapUsd != null ? `MC ${usd(k.marketCapUsd)}` : null, k.volume24hUsd != null ? `vol ${usd(k.volume24hUsd)}` : null, new Date(k.launchedAt).toLocaleDateString()].filter(Boolean).join(' · ') }))))
        : [h('li', { cls: 'fine', text: 'No coin launched here yet. Be the first.' })]));
    }
  }
  async function loadParent() { parent = await api('/_api/launch'); drawParent(); }

  // --- the form -> review -> one signed message -> SUB-01 ------------------------------------------------------------------
  function drawForm() {
    const field = (label, el, extra) => h('div', { cls: 'app-field' }, h('label', { cls: 'app-label', text: label }), el, extra || null);
    const name = h('input', { type: 'text', maxlength: 32, placeholder: pads() ? 'Launchpad name' : 'Coin name', 'aria-label': 'Name' });
    // 'choice': the launcher ticks it; 'launchpads': said plainly, nothing to tick (the server decides from the block)
    const padBox = parent.childrenMode === 'choice' && parent.childCanBeLaunchpad ? h('input', { type: 'checkbox', 'aria-label': 'Make it a launchpad' }) : null;
    const padField = padBox ? h('label', { cls: 'ln-pad' }, padBox, h('span', {}, h('strong', { text: 'Make it a launchpad' }),
      h('span', { cls: 'fine', text: `Its own site gets a launch block, so others launch coins from it (generation ${parent.childDepth} of at most ${parent.maxDepth}). Creator fees of those coins flow up to you, this site's author and SUB-01.` })))
      : pads() ? h('p', { cls: 'ln-pad', role: 'note' }, h('span', {}, h('strong', { text: 'You launch a launchpad' }),
        h('span', { cls: 'fine', text: `A real coin whose own site launches coins too (generation ${parent.childDepth} of at most ${parent.maxDepth}). Coins launched from it pay creator fees up the tree: their creator, you, this site's author, SUB-01.` }))) : null;
    const ticker = h('input', { type: 'text', maxlength: 10, placeholder: 'TICKER', 'aria-label': 'Ticker' });
    const desc = h('textarea', { rows: 4, maxlength: 500, placeholder: `What is it? At least ${parent.minDescription} characters: SUB-01 reads it.`, 'aria-label': 'Description' });
    const cnt = h('span', { cls: 'counter', text: '0 / 500' });
    desc.addEventListener('input', () => { cnt.textContent = `${[...desc.value].length} / 500`; });
    ticker.addEventListener('input', () => { ticker.value = ticker.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', 'aria-label': 'Image' });
    const preview = h('img', { cls: 'ln-preview', alt: '', hidden: true });
    let image = null;                                       // {b64, sha, url}
    file.addEventListener('change', async () => {
      image = null; preview.hidden = true;
      const f = file.files?.[0]; if (!f) return;
      if (f.size > 1_500_000) { say(m, 'Images up to 1.5 MB.', 'err'); file.value = ''; return; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
      image = { b64: toB64(bytes), sha, url: URL.createObjectURL(f) };
      preview.src = image.url; preview.hidden = false; say(m, '');
    });
    const buy = parent.devBuy ? h('input', { type: 'number', min: 0, max: parent.maxDevBuySol, step: 0.001, value: '0', 'aria-label': 'Dev buy (SOL)' }) : null;
    const m = msg(), review = h('div', { cls: 'ln-review' });
    const go = h('button', { cls: 'btn', type: 'button', text: 'Connect wallet and review', onclick: () => busy(go, async () => {
      review.replaceChildren();
      if (!image) { say(m, 'Pick an image (PNG, JPEG, GIF or WebP, up to 1.5 MB).', 'err'); return; }
      try {
        say(m, 'Connecting your wallet…');
        const { account } = await connect();
        const fields = { name: name.value.trim(), ticker: ticker.value.trim(), description: desc.value.trim(), devBuySol: buy ? Number(buy.value || 0) : 0, ...(padBox ? { launchpad: padBox.checked } : {}) };
        const q = await api('/_api/launch/quote', { wallet: account.address, ...fields, imageSha256: image.sha });
        say(m, '');
        const sign = h('button', { cls: 'btn', type: 'button', text: 'Sign and send to SUB-01', onclick: () => busy(sign, async () => {
          say(m, 'Waiting for your wallet… (a message, not a transaction: it creates and pays nothing)');
          try {
            const signature = await signText(q.message);
            say(m, 'Sending it to SUB-01…');
            const r = await api('/_api/launch/start', { wallet: account.address, nonce: q.nonce, signature, ...fields, image: image.b64 });
            store.set(keyOf(r.id), r.key); store.set(LAST, r.id);
            review.replaceChildren(); name.value = ''; ticker.value = ''; desc.value = ''; file.value = ''; preview.hidden = true; image = null;
            say(m, 'Sent. SUB-01 is reading it.', 'ok');
            follow(r.id);
          } catch (e) { say(m, e.body?.error === 'nonce_expired' ? 'The review expired; review it again.' : explain(e), 'err'); }
        }) });
        review.replaceChildren(h('div', { cls: 'ln-card' },
          h('span', { cls: 'eyebrow', text: 'Review before you sign' }),
          h('div', { cls: 'ln-coin' }, h('img', { src: image.url, alt: '', width: 72, height: 72 }), h('div', {}, h('strong', { text: `${fields.name} $${fields.ticker}` }), h('p', { cls: 'fine', text: fields.description }))),
          h('p', { cls: 'fine', text: q.launchpad ? `What you launch: a LAUNCHPAD, generation ${q.depth} of at most ${q.maxDepth}. Its own site launches coins too.` : parent.childrenMode && parent.childrenMode !== 'coins' ? `What you launch: a coin (not a launchpad).` : '' }),
          h('p', { cls: 'fine', text: `Network: ${q.mock ? 'MOCK provider (rehearsal, no blockchain)' : `pump.fun on Solana ${q.network}`}. Created by your wallet ${short(account.address)}, which pays the network fee and rent (about 0.02 SOL).` }),
          h('h4', { text: q.splitTx ? 'Creator fees: split on-chain, locked in step 2 (one more signature right after the coin is created)' : 'Creator fees: split on-chain, locked at launch' }), splitRows(q.recipients),
          h('p', { cls: 'fine', text: `Dev buy: ${q.initialBuyLamports > 0 ? `${sol(q.initialBuyLamports)} of your own coin, ${q.splitTx ? 'with step 2 when it fits, else right after it' : 'a second signature right after the launch'} (pump.fun's fees included; you can skip it then)` : 'none'}.` }),
          h('ol', { cls: 'fine ln-how' }, h('li', { text: 'You sign one message (below). It is not a transaction.' }), h('li', { text: 'SUB-01 votes on it, in seconds. He may pass: then nothing is created.' }),
            h('li', { text: 'If he builds it, you review the exact launch transaction here and sign it in your wallet.' }),
            ...(q.splitTx ? [h('li', { text: 'Right after the coin is created, one more signature (yours alone) writes and locks the fee split above on chain. Until then it is NOT locked.' })] : []), h('li', { text: 'The coin, its name, image and description are public; the split above cannot be changed afterwards, by anyone at SUBZERONE or by you.' })),
          h('details', {}, h('summary', { text: 'The exact message you sign' }), h('pre', { cls: 'pq-code', text: q.message })),
          h('div', { cls: 'row' }, sign, h('button', { cls: 'btn btn-ghost', type: 'button', text: 'Edit', onclick: () => review.replaceChildren() }))));
        slideIn(review.firstChild);
      } catch (e) { say(m, explain(e), 'err'); }
    }) });
    form.replaceChildren(h('p', { text: b.prompt }),
      padField, field('Name', name), field('Ticker', ticker), field('Description', desc, cnt), field('Image (PNG, JPEG, GIF or WebP, up to 1.5 MB)', file, preview),
      buy ? field(`Dev buy in SOL (optional, up to ${parent.maxDevBuySol})`, buy) : null,
      ...(parent.open ? [h('div', { cls: 'row' }, go)] : [h('p', { cls: 'msg err', text: parent.pausedNote || 'Launches are closed right now.' })]), m, review);
  }

  // --- one launch, followed to the end ----------------------------------------------------------------------------------------
  let timer = null, following = null;
  function follow(id) {
    following = id; clearTimeout(timer);
    const tickFn = async () => {
      if (following !== id) return;
      let s; try { s = await api(`/_api/launch/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 404) { store.set(LAST, ''); live.replaceChildren(); return; } timer = setTimeout(tickFn, 5000); return; }
      drawLive(s);
      // a two-step launch: keep following until the fee split is locked (step 2) or flagged
      const splitOpen = s.status === 'launched' && s.split && !['locked', 'mismatch'].includes(s.split.state);
      if (!DONE.has(s.status) || splitOpen || (s.status === 'launched' && s.devBuy && ['submitted', 'awaiting_signature'].includes(s.devBuy.status))) timer = setTimeout(tickFn, splitOpen && s.split.state === 'pending' ? 5000 : 2500);
      else if (s.status === 'launched') loadParent().catch(() => {});
    };
    tickFn();
  }
  const keyFor = (id) => store.get(keyOf(id));
  let busyStep = false;                                     // a wallet prompt is open: the poll leaves the buttons alone
  const seen = new Map();                                   // launch id -> the transaction last shown for review
  const autoSplit = new Set();                              // launch ids whose tx1 this page signed: step 2 opens by itself after it lands
  function drawLive(s) {
    if (busyStep) return;
    const at = ORDER[s.status] ?? -1, m = msg();
    // a two-step launch (the fee split is its own second signature): "Launched" only once the split is locked
    const sp = s.split && typeof s.split === 'object' ? s.split : null, splitDone = !sp || sp.state === 'locked';
    const list = sp ? [...STEPS.slice(0, -1), ['launched', 'Coin created'], ['split', 'Fee split locked']] : STEPS;
    const steps = h('ol', { cls: 'ln-steps' }, ...list.map(([k, l], i) => h('li', { cls: k === 'split' ? (sp.state === 'locked' ? 'done' : s.status === 'launched' ? 'now' : '')
      : i < at || s.status === 'launched' ? 'done' : i === at ? 'now' : '', text: l })));
    const kids = [h('span', { cls: 'eyebrow', text: 'Your launch' }), h('div', { cls: 'ln-coin' }, h('img', { src: s.coin.imageUrl, alt: '', width: 56, height: 56 }),
      h('div', {}, h('strong', { text: `${s.coin.name} $${s.coin.ticker}` }), h('p', { cls: 'fine', text: `${s.stageLabel}${s.note ? `: ${s.note}` : ''}` }))), steps];
    if (s.verdict) {
      const v = s.verdict;
      kids.push(h('div', { cls: `ln-verdict ${v.verdict}` }, h('strong', { text: `SUB-01: ${v.verdict === 'build' ? 'build' : 'pass'}${v.buildPct != null ? ` (build ${v.buildPct}%)` : ''}${v.latencyMs != null ? ` · ${(v.latencyMs / 1000).toFixed(1)} s` : ''}` }),
        v.summary ? h('p', { text: v.summary }) : null,
        ...(v.likes || []).slice(0, 3).map((x) => h('p', { cls: 'fine', text: `+ ${x}` })), ...(v.dislikes || []).slice(0, 3).map((x) => h('p', { cls: 'fine', text: `− ${x}` })),
        ...(v.verdict === 'pass' ? (v.suggestions || []).slice(0, 2).map((x) => h('p', { cls: 'fine', text: `→ ${x.what}${x.how ? `: ${x.how}` : ''}` })) : [])));
    }
    const key = keyFor(s.id), step = (label, fn, ghost = false) => {
      const btn = h('button', { cls: `btn${ghost ? ' btn-ghost' : ''}`, type: 'button', text: label, onclick: () => busy(btn, async () => { busyStep = true; try { await fn(); } catch (e) { say(m, explain(e), 'err'); } finally { busyStep = false; follow(s.id); } }) });
      return btn;
    };
    const network = s.config?.network || s.launch?.network;
    const txLines = (tx) => { const est = tx.estimate || {}; return [
      h('p', { cls: 'fine', text: `What your wallet signs: ${tx.mock ? 'a MOCK document, signed as a message (nothing on any chain)' : `${tx.txBytes} bytes, ${tx.signers} signer${tx.signers === 1 ? '' : 's'} (you${tx.signers > 1 ? ' and the new mint key' : ''}), ${tx.accountsWritable} writable accounts`}. Programs: ${(tx.programs || []).map((x) => x.name).join(', ')}${tx.launchProgramsOnly ? ' (launch programs only)' : ''}.` }),
      h('p', { cls: 'fine', text: `Network fee ${sol(est.networkFeeLamports)} · rent for the new accounts ${sol(est.accountsLamports)}${est.simulation?.ok ? ` · simulated: ok${est.simulation.unitsConsumed ? ` (${est.simulation.unitsConsumed} CU)` : ''}` : ''} · mint ${tx.mint}.` })]; };
    if (s.config && ['launch_prepared', 'awaiting_signature'].includes(s.status)) {
      const c = s.config;
      kids.push(h('div', { cls: 'ln-card' }, h('span', { cls: 'eyebrow', text: 'The launch, as configured' }),
        h('p', { cls: 'fine', text: `${c.providerLabel}. Token: ${c.token.name} ($${c.token.symbol}), ${c.token.decimals} decimals, metadata ${c.token.uri}. Configuration sha256 ${c.configHash}.` }),
        h('h4', { text: `Creator fees: ${c.locked ? 'locked on-chain' : 'direct'}` }), splitRows(c.recipients || []),
        c.initialBuyLamports > 0 ? h('p', { cls: 'fine', text: `Dev buy: ${sol(c.initialBuyLamports)}${c.devBuyMode === 'second_tx' ? ', a second signature right after the launch' : ' inside the creation transaction'}.` }) : null,
        h('ul', { cls: 'fine' }, ...(c.irreversible || []).map((x) => h('li', { text: x })))));
      if (key) {
        const review = h('div', { cls: 'ln-tx' }, ...(seen.get(s.id) ? txLines(seen.get(s.id)) : []));
        const show = async () => { const tx = await api(`/_api/launch/${s.id}/tx`, { key }); seen.set(s.id, tx); };
        const sign = async () => {
          say(m, 'Refreshing the blockhash…');
          const tx = await api(`/_api/launch/${s.id}/refresh`, { key }); seen.set(s.id, tx); review.replaceChildren(...txLines(tx));
          say(m, 'Check it in your wallet, then approve…');
          const signed = tx.mock ? await signText(tx.mockSigningText) : await signTx(tx.txBase64, network);
          say(m, 'Signed; sending it to the network…');
          const out = await api(`/_api/launch/${s.id}/signed`, { key, signed });
          if (tx.splitTx) autoSplit.add(s.id);                // step 2 follows by itself once the coin is confirmed
          return out;
        };
        kids.push(review, h('div', { cls: 'row' }, ...(s.status === 'launch_prepared' ? [step('Prepare the transaction', show)]
          : [step('Sign the launch in your wallet', sign), ...(seen.get(s.id) ? [] : [step('Show the transaction', show, true)]),
            step('Cancel', async () => { await api(`/_api/launch/${s.id}/abandon`, { key }); seen.delete(s.id); }, true)])));
      } else kids.push(h('p', { cls: 'fine', text: 'This browser does not hold the key of this launch. Open the coin in SUBZERONE with the wallet that started it to continue.' }));
    }
    if (s.status === 'confirming') kids.push(h('p', { cls: 'fine', text: 'Waiting for the network to finalize it, then every on-chain check runs before it is called launched.' }), s.intent?.explorerTx ? h('a', { cls: 'fine', href: s.intent.explorerTx, target: '_blank', rel: 'noopener noreferrer', text: 'The transaction on Solscan ↗' }) : null);
    if (s.status === 'launched' && s.launch && !splitDone) {
      // step 2 of 2: the coin exists, its fee split is NOT locked until this signature lands
      const a = sp.attempt || null, err = String(a?.error || '').replace(/^before signing: |^preflight: /, '');
      const lock = (separateBuy) => async () => {
        say(m, 'Building the fee-split transaction…');
        await api(`/_api/launch/${s.id}/split/tx`, { key, ...(separateBuy ? { separateBuy: true } : {}) });
        const tx = await api(`/_api/launch/${s.id}/split/refresh`, { key });
        seen.set(`${s.id}:split`, tx);
        say(m, `Step 2 of 2: check it in your wallet (one signature, yours: it writes and locks ${tx.splitText}${tx.withBuy ? ` and buys ${sol(tx.costLamports ?? tx.requestedLamports)} of your coin` : ''}), then approve…`);
        let signed;
        try { signed = tx.mock ? await signText(tx.mockSigningText) : await signTx(tx.txBase64, s.launch.network); } catch (e) { await api(`/_api/launch/${s.id}/split/abandon`, { key, reason: 'rejected' }).catch(() => {}); throw e; }
        say(m, 'Signed; locking the fee split…');
        await api(`/_api/launch/${s.id}/split/signed`, { key, signed });
      };
      kids.push(h('div', { cls: 'ln-card' }, h('strong', { text: `Coin created ✓ ${s.launch.provider === 'mock' ? '(MOCK, no blockchain)' : `on ${s.launch.network}`}` }),
        h('p', { cls: 'fine', text: `Mint ${s.launch.mint} · ${s.launch.checks} on-chain checks passed.` }),
        h('h4', { text: sp.state === 'mismatch' ? 'The fee split on chain is NOT the approved one' : `Step 2: lock the fee split (${sp.text})` }), splitRows(s.recipients || []),
        h('p', { cls: 'fine', text: sp.state === 'mismatch' ? 'SUBZERONE has been alerted; nothing here can change it.'
          : sp.state === 'submitted' ? 'Signed · locking the fee split… the network decides, not the server.'
            : `Until you sign step 2 the fee split is NOT locked: creator fees go to your own wallet's vault and nobody else gets their share.${err ? ` Last try: ${err}.` : ''}` })));
      if (key && ['pending', 'failed', 'awaiting_signature'].includes(sp.state)) {
        const lockBtn = step(sp.state === 'failed' ? 'Try again: lock the fee split' : 'Lock the fee split in your wallet', lock(false));
        kids.push(h('div', { cls: 'row' }, lockBtn, ...((a?.withBuy || sp.state === 'failed') && s.devBuy && ['pending', 'failed'].includes(s.devBuy.status) ? [step('Lock it without the dev buy', lock(true), true)] : [])));
        if (sp.state === 'pending' && autoSplit.has(s.id)) { autoSplit.delete(s.id); setTimeout(() => lockBtn.click(), 0); }
      } else if (!key && sp.state !== 'mismatch') kids.push(h('p', { cls: 'fine', text: 'This browser does not hold the key of this launch. Open it with the wallet that started it to lock the fee split.' }));
    }
    if (s.status === 'launched' && s.launch && splitDone) {
      kids.push(h('div', { cls: 'ln-card ok' }, h('strong', { text: `Launched ✓ ${s.launch.provider === 'mock' ? '(MOCK, no blockchain)' : `on ${s.launch.network}`}` }),
        h('p', { cls: 'fine', text: `Mint ${s.launch.mint} · ${s.launch.checks} on-chain checks passed.` }),
        s.launchpad ? h('p', { cls: 'fine', text: `It is a launchpad (generation ${s.depth}): its own site launches the next generation.` }) : null,
        h('div', { cls: 'row' }, s.project?.siteUrl ? h('a', { cls: 'btn btn-sm', href: s.project.siteUrl, target: '_blank', rel: 'noopener noreferrer', text: s.launchpad ? 'Its launchpad site ↗' : 'Its site ↗' }) : null,
          s.launch.explorerToken ? h('a', { cls: 'btn btn-sm btn-ghost', href: s.launch.explorerToken, target: '_blank', rel: 'noopener noreferrer', text: 'Solscan ↗' }) : null,
          s.project?.cityUrl ? h('a', { cls: 'btn btn-sm btn-ghost', href: s.project.cityUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Its building in the city ↗' }) : null),
        s.registry ? h('p', { cls: 'fine', text: `Signed into this site's post-quantum registry as entry #${s.registry.seq} (ML-DSA-65): your browser checks it in the registry on this page.` }) : null));
      const d = s.devBuy;
      if (d && key && ['pending', 'failed', 'awaiting_signature'].includes(d.status)) {
        kids.push(h('p', { cls: 'fine', text: `Step 2: your dev buy of ${sol(d.lamports)}, at the price now (capped at +${d.slippageBps / 100}%).${d.attempt?.error ? ` Last try: ${d.attempt.error}` : ''}` }),
          h('div', { cls: 'row' }, step('Sign the dev buy', async () => {
            await api(`/_api/launch/${s.id}/devbuy/tx`, { key });
            const tx = await api(`/_api/launch/${s.id}/devbuy/refresh`, { key });
            say(m, 'Check it in your wallet, then approve…');
            const signed = tx.mock ? await signText(tx.mockSigningText) : await signTx(tx.txBase64, s.launch.network);
            await api(`/_api/launch/${s.id}/devbuy/signed`, { key, signed });
          }), step('Skip it', async () => { await api(`/_api/launch/${s.id}/devbuy/skip`, { key }); }, true)));
      } else if (d) kids.push(h('p', { cls: 'fine', text: `Dev buy: ${d.status}${d.attempt?.tokensBase && d.status === 'done' ? ` (${d.attempt.tokensBase} base units)` : ''}.` }));
    }
    if (DONE.has(s.status) && !(s.status === 'launched' && ((sp && sp.state !== 'locked') || (s.devBuy && !['done', 'skipped'].includes(s.devBuy.status))))) {
      kids.push(h('button', { cls: 'btn btn-sm btn-ghost', type: 'button', text: s.status === 'launched' ? 'Launch another' : 'Close', onclick: () => { store.set(LAST, ''); following = null; live.replaceChildren(); } }));
    }
    kids.push(m);
    live.replaceChildren(h('div', { cls: 'ln-card' }, ...kids));
  }

  slot.replaceChildren(head, live, form, ...(b.list ? [h('h4', { cls: 'ln-h', text: b.children === 'launchpads' ? 'Launched here' : 'Coins launched here' }), list] : []));
  return loadParent().then(() => {
    drawForm();
    const last = store.get(LAST);
    if (last && keyFor(last)) follow(last);
    setInterval(() => { loadParent().catch(() => {}); }, 60_000);
  });
}
