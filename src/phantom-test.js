// Admin-only Phantom diagnostic (2026-10-15): which part of the pump.fun launch transaction makes Phantom show "This
// dApp could be malicious"? The page (phantomTestPage) asks the server for one variant at a time, hands it to the wallet
// for a signature ONLY (never a send), and the admin notes whether the red warning appeared. Each variant is a real
// mainnet message (live blockhash, the real lookup table, payer = the admin's wallet), built exactly as
// launch/pumpfun.js builds a launch, but:
//   - the mint is a fresh random keypair per request whose secret is never kept: nothing can ever complete it, so even
//     a broadcast of a signed copy would fail for the missing mint signature (asserted on every build: the mint slot
//     in the returned bytes is empty);
//   - no project, no intent, no database row, no SUB-01 secret: SUB01_FEE_WALLET is a public address, used as a
//     shareholder in variant C exactly as in a real launch;
//   - this module has no path that broadcasts or simulates anything; the signed bytes never come back to the server.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { launchInstructions, phantomSafeTables } from './launch/pumpfun.js';
import { escapeHtml as e } from './util.js';

const require = createRequire(import.meta.url);
const MAX_TX_BYTES = 1232;
export const LAUNCH_LOOKUP_TABLE = 'FriBQZvUdjCuqvWiUhicoTbYm5GVAEZkDpDPRqRvmbk6';
export const PADPAD_MINT = '8zmFs8YsZAd2FQXWJjqLSoHGVEsiKuheeKj4hhWXMops';
const TEST_TOKEN = { name: 'PHANTOM TEST', symbol: 'PTEST' };

export const VARIANTS = Object.freeze({
  A: 'pump.fun create_v2 only (with the lookup table)',
  C: 'create_v2 + createFeeSharingConfig + updateFeeSharesV2 80/20: the real launch shape (with the lookup table)',
  E: 'control: a 0-lamport System transfer to yourself (if THIS warns, it is the domain or the session, not our instructions)',
});

/** The wallet chain id for the launch network. */
export const walletChain = (network) => (network === 'mainnet-beta' ? 'solana:mainnet' : `solana:${network || 'devnet'}`);

/** -> { build({variant, wallet}) } bound to the launch RPC (or a test connection: getLatestBlockhash, getAddressLookupTable). */
export function createPhantomTest(cfg, { connection = null } = {}) {
  const web3 = require('@solana/web3.js');
  let conn = connection;
  const rpc = () => (conn ||= new web3.Connection(cfg.launch.rpcUrl, 'confirmed'));
  const tableAddress = () => cfg.launch.lookupTable || (cfg.launch.network === 'mainnet-beta' ? LAUNCH_LOOKUP_TABLE : '');

  async function tables() {
    const at = tableAddress();
    if (!at) return { list: [], note: 'no lookup table configured (LAUNCH_LOOKUP_TABLE): built without one' };
    const r = await rpc().getAddressLookupTable(new web3.PublicKey(at));
    if (!r?.value) return { list: [], note: `lookup table ${at} not found on this network: built without one` };
    return { list: [r.value], note: null, address: at };
  }

  async function build({ variant, wallet }) {
    const v = String(variant || '').toUpperCase();
    if (!VARIANTS[v]) throw Object.assign(new Error('unknown variant'), { code: 'bad_variant' });
    const payer = new web3.PublicKey(wallet);
    // a throwaway mint: only its public key is used; the secret is never read, stored or returned
    const mint = web3.Keypair.generate().publicKey;
    const out = { variant: v, description: VARIANTS[v], network: cfg.launch.network, chain: walletChain(cfg.launch.network), notes: [] };
    let ixs, useTable = true, mintSigner = true;
    if (v === 'E') {
      ixs = [web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 })];
      useTable = false; mintSigner = false;
    } else if (v === 'F') {
      const { pump, spl } = sdk();
      const target = new web3.PublicKey(PADPAD_MINT);
      try {
        ixs = [await pump.PUMP_SDK.createFeeSharingConfig({ creator: payer, mint: target, pool: null }),
          await pump.PUMP_SDK.updateFeeSharesV2({ authority: payer, mint: target, currentShareholders: [payer],
            newShareholders: split(web3, payer, cfg), quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID, bondingCurveComplete: false })];
      } catch (err) {
        return { ...out, skipped: true, reason: `the SDK refused to build it offline: ${err.message}` };
      }
      mintSigner = false;
      out.notes.push(`target mint ${PADPAD_MINT} (PadPad): it would fail on-chain, you are not its creator; nothing is sent anyway`);
    } else {
      const config = { ...TEST_TOKEN, uri: `${cfg.publicOrigin}/m/${randomBytes(8).toString('hex')}.json`, initialBuyLamports: 0,
        feeSharing: { mode: 'sharing_config', shareholders: split(web3, payer, cfg).map((s) => ({ wallet: s.address.toBase58(), bps: s.shareBps })) } };
      ixs = (await launchInstructions({ config, mint, signer: payer })).ixs;
      if (v === 'A') ixs = ixs.slice(0, 1);
      if (v === 'B') ixs = ixs.slice(0, 2);
      if (v === 'D') useTable = false;
      if (v === 'C' || v === 'D') out.notes.push(`split: 80% ${payer.toBase58()} (you), 20% ${shareholderNote(cfg)}`);
    }
    const { blockhash } = await rpc().getLatestBlockhash('confirmed');
    let lookup = [];
    if (useTable) {
      const t = await tables();
      // the same layout prepare() uses: compact by default, event authorities written in with LAUNCH_EVENT_AUTH_STATIC=1
      lookup = cfg.launch.eventAuthStatic === true ? phantomSafeTables(t.list) : t.list;
      if (t.note) out.notes.push(t.note); else out.notes.push(`lookup table ${t.address}${cfg.launch.eventAuthStatic ? ' (event authorities written in)' : ''}`);
    }
    const message = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookup);
    const tx = new web3.VersionedTransaction(message);
    let bytes;
    try { bytes = tx.serialize(); } catch (err) {
      if (!/overruns/.test(err.message)) throw err;
      return { ...out, skipped: true, reason: `over ${MAX_TX_BYTES} bytes: web3.js cannot even encode it (${legacyNote(web3, payer, blockhash, ixs)})` };
    }
    if (bytes.length > MAX_TX_BYTES) return { ...out, skipped: true, bytes: bytes.length, reason: `${bytes.length} bytes, over the ${MAX_TX_BYTES}-byte network limit: no wallet could ever see it` };
    const check = assertUnsignable(bytes, { payer: payer.toBase58(), mint: mintSigner ? mint.toBase58() : null });
    return { ...out, txBase64: Buffer.from(bytes).toString('base64'), bytes: bytes.length, signers: check.signers, mint: mintSigner ? mint.toBase58() : null,
      mintSignatureEmpty: mintSigner ? true : null, instructions: ixs.length, lookupTable: useTable && lookup.length > 0 };
  }
  return { build, tableAddress };
}

let _sdk = null;
function sdk() { return (_sdk ||= { pump: require('@pump-fun/pump-sdk'), spl: require('@solana/spl-token') }); }

/** 80% to the admin, 20% to SUB01_FEE_WALLET (a random throwaway key when it is unset locally). */
let _sub01 = null;
function split(web3, payer, cfg) {
  const sub = cfg.sub01FeeWallet ? new web3.PublicKey(cfg.sub01FeeWallet) : (_sub01 ||= web3.Keypair.generate().publicKey);
  return [{ address: payer, shareBps: 8000 }, { address: sub, shareBps: 2000 }];
}
const shareholderNote = (cfg) => (cfg.sub01FeeWallet ? `${cfg.sub01FeeWallet} (SUB01_FEE_WALLET)` : 'a random stand-in (SUB01_FEE_WALLET is not set here)');
function legacyNote(web3, payer, blockhash, ixs) {
  try { return `legacy message: ${new web3.Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes`; } catch { return 'legacy message: also over the limit'; }
}

/**
 * Every returned transaction is unsigned and the throwaway mint's signature slot is empty (all zero bytes), so the
 * bytes on their own can never land. Throws otherwise; also checks the payer is the admin and the only other signer
 * (if any) is the throwaway mint.
 */
export function assertUnsignable(bytes, { payer, mint }) {
  const web3 = require('@solana/web3.js');
  const tx = web3.VersionedTransaction.deserialize(bytes);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const n = tx.message.header.numRequiredSignatures;
  const signers = keys.slice(0, n);
  if (signers[0] !== payer) throw new Error('phantom-test: the payer is not the admin wallet');
  if (signers.length !== (mint ? 2 : 1) || (mint && signers[1] !== mint)) throw new Error(`phantom-test: unexpected signers ${signers.join(',')}`);
  if (!tx.signatures.every((s) => s.every((b) => b === 0))) throw new Error('phantom-test: a returned transaction carries a signature');
  if (mint && !tx.signatures[keys.indexOf(mint)].every((b) => b === 0)) throw new Error('phantom-test: the mint signature slot is not empty');
  return { signers };
}

export const phantomTestCsp = (nonce) => ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`, "connect-src 'self'",
  "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"].join('; ');

/**
 * The page. state: 'signin' (no session: connect + sign in with the wallet), 'forbidden' (signed in, not in
 * ADMIN_WALLETS), 'admin' (the tool). The script only ever asks the wallet to SIGN; the signed bytes are dropped.
 */
export function phantomTestPage({ nonce, state, wallet = null, network = 'mainnet-beta' }) {
  const rows = Object.entries(VARIANTS).map(([k, d]) => `<li class="v"><div><b>${k}</b> <span>${e(d)}</span><small id="m${k}"></small></div><button data-v="${k}" disabled>Test ${k}</button></li>`).join('');
  const body = state === 'admin' ? `
<section class="card"><h2>How it works / Come funziona</h2>
<p>Press a button. Phantom will open. Look whether it shows the red <b>“This dApp could be malicious”</b> warning. Then press <b>Reject / Cancel</b>. Nothing is spent: the page only asks for a signature, never sends, and every transaction is missing the signature of a throwaway mint key, so it could not land even if it were sent.</p>
<p lang="it">Premi un pulsante. Si apre Phantom. Guarda se compare l'avviso rosso <b>“This dApp could be malicious”</b>. Poi premi <b>Rifiuta / Annulla</b>. Non si spende nulla: la pagina chiede solo una firma, non invia mai, e ogni transazione manca della firma di una chiave mint usa-e-getta, quindi non potrebbe andare a buon fine nemmeno se venisse inviata.</p>
<p class="row"><span>Wallet: <code id="who">${e(wallet || '')}</code></span>
<label>Signing path <select id="path"><option value="standard">Wallet Standard solana:signTransaction (as the city)</option><option value="phantom">window.phantom.solana.request signTransaction</option></select></label>
<button id="connect">Connect Phantom</button></p>
<p id="status" role="status">Connect Phantom with the same wallet you signed in with.</p></section>
<section class="card"><h2>Variants</h2><ol class="vs">${rows}</ol>
<div id="ask" hidden><p>Variant <b id="askv"></b>: did Phantom show the red warning? / Phantom ha mostrato l'avviso rosso?</p><button id="yes">Warning shown / Avviso mostrato</button> <button id="no">No warning / Nessun avviso</button></div></section>
<section class="card"><h2>Results / Risultati</h2><table><thead><tr><th>Time</th><th>Var.</th><th>Bytes</th><th>Path</th><th>Wallet answer</th><th>Warning</th></tr></thead><tbody id="res"></tbody></table>
<p class="row"><button id="copy">Copy results</button><button id="clear">Clear</button><span id="copied"></span></p></section>`
    : state === 'forbidden' ? `<section class="card"><h2>Not an admin wallet</h2><p>You are signed in as <code>${e(wallet || '')}</code>, which is not in ADMIN_WALLETS. Sign out in the city and sign in with an admin wallet.</p></section>`
      : `<section class="card"><h2>Sign in</h2><p>Admins only. Connect Phantom and sign the sign-in message (a message, not a transaction: free). / Solo admin: collega Phantom e firma il messaggio di accesso (gratis).</p><p class="row"><button id="signin">Connect &amp; sign in</button></p><p id="status" role="status"></p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Phantom test · SUBZERONE admin</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;background:#0f0d0b;color:#f3efe8;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:17px;margin:0 0 10px}
.sub{color:#8e877e;margin:0 0 18px}.card{padding:18px;border-radius:18px;background:#1a1715;box-shadow:inset 0 0 0 1px #ffffff14;margin:0 0 16px}
p{margin:0 0 12px;color:#cfc8bf}b{color:#f3efe8}code{font:12px/1.4 ui-monospace,Menlo,monospace;word-break:break-all;color:#f3efe8}
button,select{font:inherit;border:0;border-radius:10px;padding:8px 14px;background:#fb752b;color:#0f0d0b;font-weight:700;cursor:pointer}
select{background:#2a2522;color:#f3efe8;font-weight:400;max-width:100%}button[disabled]{opacity:.4;cursor:default}#no,#clear{background:#3a3430;color:#f3efe8}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.vs{list-style:none;margin:0;padding:0}
.v{display:flex;gap:12px;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid #ffffff10}.v span{color:#cfc8bf}.v small{display:block;color:#8e877e;font-size:12px}
.v button{flex:none}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 6px;border-top:1px solid #ffffff10}th{color:#8e877e;font-weight:600}
#status{color:#f3efe8}.warn{color:#ff8a7a}.ok{color:#9be29b}
@media (max-width:560px){.v{flex-direction:column;align-items:stretch}th:nth-child(4),td:nth-child(4){display:none}}
</style></head><body><main><h1>Phantom warning test</h1><p class="sub">Admin diagnostic · network ${e(network)} · nothing is ever sent / non viene mai inviato nulla</p>${body}</main>
<script nonce="${nonce}">${PAGE_SCRIPT.replace('__CHAIN__', JSON.stringify(walletChain(network))).replace('__STATE__', JSON.stringify(state)).replace('__WALLET__', JSON.stringify(wallet || ''))}</script></body></html>`;
}

// The page script. It asks the wallet to SIGN only; whatever comes back is dropped on the spot (never posted, never kept).
const PAGE_SCRIPT = String.raw`(function(){'use strict';
var CHAIN=__CHAIN__,STATE=__STATE__,WALLET=__WALLET__,KEY='phantom-test-results-v1';
var $=function(id){return document.getElementById(id);};
var say=function(t,c){var s=$('status');if(s){s.textContent=t;s.className=c||'';}};
var A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(b){var d=[0],i,j,c;for(i=0;i<b.length;i++){c=b[i];for(j=0;j<d.length;j++){c+=d[j]<<8;d[j]=c%58;c=(c/58)|0;}while(c){d.push(c%58);c=(c/58)|0;}}var s='';for(i=0;i<b.length&&b[i]===0;i++)s+='1';for(i=d.length-1;i>=0;i--)s+=A[d[i]];return s;}
function fromB64(s){var bin=atob(s),o=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)o[i]=bin.charCodeAt(i);return o;}
function addr(k){if(!k)return'';if(typeof k==='string')return k;if(typeof k.toBase58==='function')return k.toBase58();try{return b58(new Uint8Array(k));}catch(e){return'';}}
// Wallet Standard discovery (Phantom registers "Phantom")
var std=null;
function reg(w){if(w&&/phantom/i.test(w.name||'')&&w.features&&w.features['standard:connect'])std=w;}
window.addEventListener('wallet-standard:register-wallet',function(ev){try{ev.detail({register:function(){for(var i=0;i<arguments.length;i++)reg(arguments[i]);return function(){};}});}catch(e){}});
try{window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register:function(){for(var i=0;i<arguments.length;i++)reg(arguments[i]);return function(){};}}}));}catch(e){}
var legacy=function(){var p=(window.phantom&&window.phantom.solana)||window.solana;return p&&p.isPhantom?p:null;};
var account=null;
async function connect(){
  if(std){var r=await std.features['standard:connect'].connect();account=(r&&r.accounts&&r.accounts[0])||(std.accounts&&std.accounts[0])||null;if(account)return account.address;}
  var p=legacy();if(!p)throw new Error('Phantom not found. Install or unlock Phantom and reload. / Phantom non trovato.');
  var res=await p.connect();return addr((res&&res.publicKey)||p.publicKey);
}
async function api(path,body){var r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j=null;try{j=await r.json();}catch(e){}if(!r.ok)throw new Error((j&&(j.message||j.error))||('HTTP '+r.status));return j;}
if(STATE==='signin'){
  $('signin').onclick=async function(){try{say('Connecting…');var w=await connect();var n=await api('/api/auth/nonce',{wallet:w});var msg=new TextEncoder().encode(n.message),sig;
    if(std&&account&&std.features['solana:signMessage']){var o=await std.features['solana:signMessage'].signMessage({account:account,message:msg});o=Array.isArray(o)?o[0]:o;sig=new Uint8Array(o.signature);}
    else{var s=await legacy().signMessage(msg,'utf8');sig=new Uint8Array(s.signature||s);}
    await api('/api/auth/verify',{wallet:w,nonce:n.nonce,signature:b58(sig)});say('Signed in. Reloading…');location.reload();}catch(e){say(String(e&&e.message||e),'warn');}};
  return;
}
if(STATE!=='admin')return;
var results=[];try{results=JSON.parse(localStorage.getItem(KEY)||'[]')||[];}catch(e){results=[];}
function save(){try{localStorage.setItem(KEY,JSON.stringify(results.slice(-200)));}catch(e){}}
function draw(){var tb=$('res');tb.textContent='';results.slice().reverse().forEach(function(r){var tr=document.createElement('tr');[r.at.slice(11,19),r.variant,r.bytes==null?'—':r.bytes,r.path,r.answer,r.warning==null?'—':(r.warning?'SHOWN':'none')].forEach(function(x,i){var td=document.createElement('td');td.textContent=String(x);if(i===5&&r.warning!=null)td.className=r.warning?'warn':'ok';tr.appendChild(td);});tb.appendChild(tr);});}
draw();
var buttons=[].slice.call(document.querySelectorAll('button[data-v]')),connected='',pending=null;
function enable(on){buttons.forEach(function(b){b.disabled=!on;});}
$('connect').onclick=async function(){try{say('Connecting…');connected=await connect();
  if(connected!==WALLET){say('Phantom is on '+connected+', but you signed in as '+WALLET+'. Switch account in Phantom and connect again.','warn');enable(false);return;}
  say('Connected. Pick a variant. / Collegato. Scegli una variante.','ok');enable(true);}catch(e){say(String(e&&e.message||e),'warn');}};
async function sign(bytes){
  var path=$('path').value;
  if(path==='phantom'){var p=legacy();if(!p||typeof p.request!=='function')throw new Error('window.phantom.solana.request is not available');return p.request({method:'signTransaction',params:{message:b58(bytes)}});}
  if(!std||!account)throw new Error('Phantom did not register through Wallet Standard here; pick the other signing path.');
  var f=std.features['solana:signTransaction'];if(!f)throw new Error('no solana:signTransaction feature');
  return f.signTransaction({transaction:bytes,account:account,chain:CHAIN});
}
buttons.forEach(function(b){b.onclick=async function(){
  var v=b.getAttribute('data-v'),path=$('path').value,row={at:new Date().toISOString(),variant:v,bytes:null,path:path==='phantom'?'phantom.request':'wallet-standard',answer:'',warning:null};
  enable(false);say('Building variant '+v+'…');
  try{var t=await api('/api/admin/phantom-test/tx',{variant:v,wallet:connected});
    $('m'+v).textContent=t.skipped?('skipped: '+t.reason):(t.bytes+' bytes'+(t.notes&&t.notes.length?' · '+t.notes.join(' · '):''));
    if(t.skipped){row.answer='skipped: '+t.reason;row.bytes=t.bytes==null?null:t.bytes;results.push(row);save();draw();say('Variant '+v+' skipped: '+t.reason,'warn');enable(true);return;}
    row.bytes=t.bytes;say('Phantom is open: look for the red warning, then press Reject. / Phantom è aperto: guarda l\'avviso rosso, poi premi Rifiuta.');
    var out=null;try{out=await sign(fromB64(t.txBase64));row.answer='SIGNED (discarded, not sent)';}catch(e){row.answer='rejected / '+String(e&&e.message||e).slice(0,60);}
    out=null; // the signed bytes, if any, are dropped here: never posted, never stored
    if(row.answer.indexOf('SIGNED')===0)say('You signed by mistake: the signed bytes were discarded in this tab and nothing was sent. / Hai firmato per errore: niente è stato inviato.','warn');
    pending=row;$('askv').textContent=v;$('ask').hidden=false;
  }catch(e){row.answer='error: '+String(e&&e.message||e).slice(0,80);results.push(row);save();draw();say(row.answer,'warn');enable(true);}
};});
function answer(w){if(!pending)return;pending.warning=w;results.push(pending);pending=null;save();draw();$('ask').hidden=true;say('Saved. Next variant. / Salvato.','ok');enable(true);}
$('yes').onclick=function(){answer(true);};$('no').onclick=function(){answer(false);};
$('copy').onclick=async function(){var txt=['time\tvariant\tbytes\tpath\twallet answer\twarning'].concat(results.map(function(r){return[r.at,r.variant,r.bytes==null?'':r.bytes,r.path,r.answer,r.warning==null?'':(r.warning?'SHOWN':'none')].join('\t');})).join('\n');
  try{await navigator.clipboard.writeText(txt);$('copied').textContent='Copied.';}catch(e){var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');$('copied').textContent='Copied.';}catch(x){$('copied').textContent='Copy failed: select the table by hand.';}ta.remove();}};
$('clear').onclick=function(){results=[];save();draw();};
})();`;
