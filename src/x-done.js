// The X OAuth round trip ends in the pop-up the room PC opened (desk.js startConnect). The city polls the project
// and flips its X tab by itself, so this page only says what happened and closes the pop-up. No framework, no
// external assets: a CSP of its own with an inline style/script only (2026-10-10, the owner: no more old pages).
import { escapeHtml as e } from './util.js';

export const X_DONE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'";

/** HTML for the end of the X connection: ok → handle + auto-close, error → the reason + "try again from the room PC". */
export function xDonePage({ ok, handle, error } = {}) {
  const title = ok ? 'X connected' : 'X not connected';
  const line = ok
    ? `SUB-01 can now write on <b>@${e(String(handle || ''))}</b>. You approve every post from the room PC.`
    : `${e(String(error || 'Something went wrong.'))} Close this window and press <b>Connect X account</b> again from the room PC.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · SUBZERONE</title>
<style>
:root{color-scheme:dark}html,body{margin:0;height:100%;background:#0f0d0b;color:#f3efe8;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{min-height:100%;display:grid;place-items:center;padding:24px}
.card{max-width:420px;padding:28px 28px 24px;border-radius:24px;background:#1a1715;box-shadow:inset 0 0 0 1px #ffffff14,0 24px 60px -24px #000}
.mark{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:${ok ? '#fb752b' : '#3a2a26'};color:#0f0d0b;font-weight:800}
h1{margin:16px 0 6px;font-size:22px;letter-spacing:-.01em}p{margin:0 0 18px;color:#cfc8bf}b{color:#f3efe8}
small{display:block;color:#8e877e}a{color:#fb752b;text-decoration:none}
</style></head><body><main><div class="card"><div class="mark" aria-hidden="true">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${line}</p>
<small id="s">${ok ? 'This window closes by itself. ' : ''}<a href="/">Back to the city</a></small></div></main>
<script>
if(${ok ? 'true' : 'false'}){setTimeout(function(){try{window.close();}catch(e){}},1600);
 setTimeout(function(){var s=document.getElementById('s');if(!window.closed&&s)s.textContent='You can close this window. ';},2400);}
</script></body></html>`;
}
