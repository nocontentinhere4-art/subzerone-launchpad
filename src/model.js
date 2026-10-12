// The language model calls the copy writer makes (generator.js writeCopy) and the model settings the composer shares
// (composer.js). One configured model for both: ANTHROPIC_MODEL (cfg.generator.anthropicModel), claude-sonnet-5-5 by
// default. Errors carry the HTTP status and the API's own message, never the key.

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const modelOf = (cfg) => String(cfg?.generator?.anthropicModel || DEFAULT_MODEL);

// models that take the server-side refusal fallback (`fallbacks: "default"` + its beta header) on the Claude API
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/;

/** Request fields that depend on the model: thinking off where the model allows it (short structured writing does not
 * need it; only Sonnet 5.5 takes `between_tools`, the others run their default), the refusal fallback where it exists. */
export function modelExtras(model) {
  return { ...(model === 'claude-sonnet-5-5' ? { thinking: { type: 'between_tools' } } : {}), ...(FALLBACK_MODELS.test(model) ? { fallbacks: 'default' } : {}) };
}

export function modelHeaders(g, model) {
  return { 'content-type': 'application/json', 'x-api-key': g.anthropicKey, ...(g.anthropicWorkspace ? { 'anthropic-workspace-id': g.anthropicWorkspace } : {}),
    'anthropic-version': '2023-06-01', ...(FALLBACK_MODELS.test(model) ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) };
}

/** A model call that did not give usable text: `status` is the HTTP status when there was one; `costUsd` what it cost. */
export class ModelError extends Error {
  constructor(message, { status = null, costUsd = 0 } = {}) { super(message); this.status = status; this.costUsd = costUsd; }
}

/** The API's own error message from a failed response, short (it never contains the key). */
async function apiMessage(res) {
  try { const j = await res.json(); return String(j?.error?.message || j?.error?.type || '').replace(/\s+/g, ' ').slice(0, 200); } catch { return ''; }
}

/**
 * POST /v1/messages with a JSON-schema output. -> { text, model, costUsd, stopReason }.
 * Throws ModelError on HTTP errors (`<label> HTTP <status>: <message>`), network failures, refusals and truncation;
 * an aborted `signal` is rethrown as it is.
 */
export async function callModel(cfg, { system, user, schema, maxTokens = 3000, signal, fetchImpl = fetch, label = 'model' }) {
  const g = cfg.generator || {};
  if (!g.anthropicKey) throw new ModelError('ANTHROPIC_API_KEY not set');
  const model = modelOf(cfg);
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], ...modelExtras(model),
    ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}) };
  const timeout = AbortSignal.timeout(g.timeoutMs || 60_000);
  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: modelHeaders(g, model), body: JSON.stringify(body) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ModelError(`${label} request failed: ${e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e).slice(0, 160)}`);
  }
  if (!res.ok) {
    const msg = await apiMessage(res);
    throw new ModelError(`${label} HTTP ${res.status}${msg ? `: ${msg}` : ''}`, { status: res.status });
  }
  const j = await res.json();
  const u = j.usage || {};
  const costUsd = ((u.input_tokens || 0) * (g.priceIn || 0) + (u.output_tokens || 0) * (g.priceOut || 0)) / 1e6;
  if (j.stop_reason === 'refusal' || j.stop_reason === 'max_tokens') throw new ModelError(`${label} stopped: ${j.stop_reason}`, { costUsd });
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { text, model: typeof j.model === 'string' && j.model ? j.model : model, costUsd, stopReason: j.stop_reason || null };
}

/** The first JSON object in a model's text (structured output gives exactly one; older fakes wrap it in prose). */
export function parseModelJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new ModelError('the answer had no JSON');
  try { return JSON.parse(m[0]); } catch { throw new ModelError('the answer was not valid JSON'); }
}
