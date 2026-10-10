// Review before sign: exactly what the wallet will show, from the server's reading of the built transaction
// (POST /api/projects/:slug/launch/transaction: network, feePayer, programs, accountsWritable, signers, launchProgramsOnly).
// Pure (lib.js only), so test/review-ui.test.js renders it in Node.
import { html, short, sol, pct } from './lib.js';

/** -> html`` result. The Sign button is disabled unless the payer is the viewer and only launch programs are called. */
export function txReview(tx, launchConfig, myWallet, walletName) {
  const e = tx.estimate || {};
  const fs = launchConfig.feeSharing;
  const total = e.networkFeeLamports != null && e.accountsLamports != null ? e.networkFeeLamports + e.accountsLamports : null;
  const you = tx.feePayer === myWallet;
  const canSign = you && tx.launchProgramsOnly === true;
  return html`<div class="card accent"><h3>${tx.mock ? 'MOCK transaction (nothing on-chain)' : 'Transaction ready'}</h3>
    <h3 style="margin-top:4px">What your wallet will see</h3>
    <div class="kv small">
    <span>network</span><span><b>${tx.network}</b></span>
    <span>fee payer</span><span class="addr">${tx.feePayer} ${you ? html`<b>(you)</b>` : html`<b class="err">(not your wallet: don't sign)</b>`}</span>
    <span>new mint address</span><span class="addr">${tx.mint}</span>
    ${tx.resumed ? html`<span>request</span><span>resumed: the same transaction you built earlier</span>` : ''}
    <span>programs it touches</span><span>${(tx.programs || []).map((x) => html`<div data-program="${x.id}">${x.name} <span class="addr faint tiny">${short(x.id, 6)}</span>${x.direct ? '' : html` <span class="faint tiny">(called inside the one above)</span>`}</div>`)}</span>
    <span>accounts it can write</span><span>${tx.accountsWritable} <span class="faint">· signatures: ${tx.signers} (your wallet${tx.signers > 1 ? ' + the new mint, already signed' : ''})</span></span>
    <span>network fee</span><span>${e.networkFeeLamports != null ? sol(e.networkFeeLamports) : 'unknown'}</span>
    <span>accounts created (rent + program costs)</span><span>${e.accountsLamports != null ? sol(e.accountsLamports) : 'unknown'} <span class="faint">${e.simulation?.ok ? '(from a simulation)' : e.simulation?.err ? `(simulation failed: ${e.simulation.err})` : ''}</span></span>
    <span>estimated cost</span><span><b>${total != null ? sol(total) : tx.mock ? sol(0) : 'unknown'}</b></span>
    ${e.signerBalanceLamports != null ? html`<span>your balance</span><span>${sol(e.signerBalanceLamports)}</span>` : ''}
    <span>size</span><span>${tx.txBytes} bytes</span><span>valid until block</span><span>${tx.lastValidBlockHeight}</span></div>
    <h3 style="margin-top:12px">Creator-fee split ${fs.locked ? html`<span class="chip">locked at launch</span>` : ''}</h3>
    <table><tr><th>who</th><th>bps</th><th>exact address</th></tr>${fs.recipients.map((x) => html`<tr><td>${x.label}</td><td>${x.bps} (${pct(x.bps)})</td><td class="addr tiny">${x.wallet}</td></tr>`)}</table>
    ${tx.launchProgramsOnly === true
    ? html`<p class="small" data-does-not><b>What this does NOT do:</b> no token approvals or delegations, no token transfers from your wallet${launchConfig?.initialBuyLamports > 0 ? `; your dev buy of ${(launchConfig.initialBuyLamports / 1e9).toFixed(4).replace(/\.?0+$/, "")} SOL is included (tokens land in your wallet)` : ", no initial buy"}. ${tx.mock ? 'Nothing leaves your wallet: you sign a text message.' : 'The only SOL that leaves your wallet is the network fee and the rent for the new accounts.'}</p>`
    : html`<p class="err small"><b>This transaction calls a program that is not part of a launch.</b> Don't sign it; tell a SUBZERONE admin.</p>`}
    <p class="small dim">Your wallet shows the transaction again before you sign. ${tx.mock ? 'For the mock, it asks you to sign a plain text message instead.' : 'Check that it shows the same network, fee payer and amounts.'}</p>
    <p class="row"><button class="primary" id="sign" ${canSign ? '' : 'disabled'}>Sign with ${walletName || 'wallet'}</button> <button id="cancelSign">cancel</button></p></div>`;
}
