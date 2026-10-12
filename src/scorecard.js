// Scorecard v1. Four criteria, each 0..1, each with its source written next to it.
// The decision to build is the brain vote's (simulation). The rules below only gate: an idea that breaks a policy,
// is unreadable or duplicates an earlier one is declined before the brain is asked.
// Nothing here scores an idea by promised returns; an idea that promises returns is declined by policy.
export const SCORECARD_VERSION = 'scorecard/1';

export const RETURNS = /\b(guarantee[ds]?|guaranteed returns?|passive income|profit[- ]?shar\w*|dividends?|revenue share|yield|apy|apr|roi|\d+\s?x\s+(gains?|returns?)|to the moon|moon ?shot|get rich|risk[- ]free|staking rewards?|holders? (get|earn|receive)|airdrop to holders)\b/i;
const HATE = /\b(nigg\w*|faggot\w*|kike\w*|chink\w*|gook\w*|tranny|retard\w*)\b/i;
const HARM = /\b(kys|kill yourself|suicide challenge|child (porn|sexual)|cp\b|loli)\b/i;
// An endorsement claim names someone: "backed by Binance", "partnered with @solana", "official token of X".
// Technology is not an endorsement: "backed by post-quantum signatures", "backed by real code" pass (2026-10-12: the
// owner's own launchpad idea was refused for "backed by" + cryptography).
const ENDORSE = /\b(official (?:token|coin|memecoin) of|endorsed by|partnered with|in partnership with|backed by|sponsored by|supported by)\s+(?:the\s+)?(@?[A-Za-z0-9][\w.$-]*)/gi;
const TECH = /^(post-?quantum|quantum|crypto(graphy|graphic)?|math(s|ematics)?|code|open-?source|real|on-?chain|solana's?|ml-dsa|ml-kem|lattices?|hash(es|-based)?|signatures?|the|a|an|our|its|community|holders?|nothing|no|zero|sub-?01|ed25519|proofs?|data|audits?|tests?|nist-standard(s|ised|ized)?|fips(-?\d+)?)$/i;
function endorsementClaim(text) {
  for (const m of String(text).matchAll(ENDORSE)) {
    const who = m[2].replace(/[.,;:!?]+$/, '');
    if (/^official/i.test(m[1])) return m[0];
    if (TECH.test(who)) continue;
    if (who.startsWith('@') || /^[A-Z0-9$]/.test(who)) return m[0];   // a name, a handle or a brand
  }
  return null;
}
const HEAVY = /\b(exchange|dex|bridge|staking|lending|borrow|marketplace|mmo|multiplayer|mobile app|blockchain|layer ?2|l2|wallet app|launchpad|casino|betting|lottery)\b/i;

const words = (s) => (String(s).toLowerCase().match(/[a-z0-9à-ÿ]+/g) || []);
function shingles(text, k = 3) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  if (out.size === 0 && w.length) out.add(w.join(' '));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

/** Hard gates. -> null | {rule, why} */
export { endorsementClaim };
export function policyCheck({ title, concept, nameSuggestion = '', tickerSuggestion = '' }) {
  const text = [title, concept, nameSuggestion, tickerSuggestion].join(' \n ');
  if (HATE.test(text)) return { rule: 'hate', why: 'contains a slur' };
  if (HARM.test(text)) return { rule: 'harm', why: 'self-harm or sexual content involving minors' };
  if (RETURNS.test(text)) return { rule: 'promised_returns', why: 'promises returns, yield or holder rewards; the launchpad does not build those' };
  const claim = endorsementClaim(text);
  if (claim) return { rule: 'impersonation', why: `claims an endorsement or official status ("${claim.slice(0, 60)}")` };
  return null;
}

/** Rule: readable length and shape. Crude on purpose; shown with its rule. */
export function clarity({ title, concept }) {
  const t = String(title).trim(), c = String(concept).trim();
  const tl = t.length >= 3 && t.length <= 60 ? 1 : 0.4;
  const len = c.length;
  const cl = len < 20 ? 0.1 : len < 60 ? 0.5 : len <= 600 ? 1 : len <= 1200 ? 0.7 : 0.4;
  const letters = (c.match(/[a-zà-ÿ]/gi) || []).length / Math.max(1, len);
  const lr = letters > 0.6 ? 1 : letters > 0.4 ? 0.6 : 0.2;
  return Math.round((0.25 * tl + 0.5 * cl + 0.25 * lr) * 100) / 100;
}

/** Rule: 1 - the highest 3-word-shingle Jaccard similarity to any earlier idea. */
export function originality({ title, concept }, others) {
  const mine = shingles(`${title} ${concept}`);
  let top = 0, match = null;
  for (const o of others) {
    const s = jaccard(mine, shingles(`${o.title} ${o.concept}`));
    if (s > top) { top = s; match = o.id; }
  }
  return { score: Math.round((1 - top) * 100) / 100, closest: match, similarity: Math.round(top * 100) / 100 };
}

/** Rule: can it be a token plus a one-page site? Products that need running infrastructure score lower. */
export function feasibility({ concept }) {
  const hits = (String(concept).match(new RegExp(HEAVY.source, 'gi')) || []).length;
  return Math.max(0.2, Math.round((1 - 0.25 * hits) * 100) / 100);
}

/** Simulation: the build option's share of the brain vote (softmax probability) and its normalised value. */
export function suitability(brainRecord) {
  const build = brainRecord?.vote?.options?.find((o) => String(o.label).startsWith('build'));
  if (!build) return null;
  return { score: Math.round(build.p * 100) / 100, value: build.value, response: build.response };
}

export const GATES = { clarity: 0.35, originality: 0.3 };

export function preGate(input, others) {
  const policy = policyCheck(input);
  const cl = clarity(input);
  const orig = originality(input, others);
  const fe = feasibility(input);
  let declined = null;
  if (policy) declined = { decidedBy: `policy:${policy.rule}`, why: policy.why };
  else if (cl < GATES.clarity) declined = { decidedBy: 'policy:unclear', why: 'too short or unreadable to build from' };
  else if (orig.score < GATES.originality) declined = { decidedBy: 'policy:duplicate', why: 'too close to an earlier idea' };
  return { policy, clarity: cl, originality: orig, feasibility: fe, declined };
}

export function scores(pre, brainRecord) {
  return {
    version: SCORECARD_VERSION,
    originality: { score: pre.originality.score, source: 'rule: shingle similarity to earlier ideas', similarity: pre.originality.similarity },
    clarity: { score: pre.clarity, source: 'rule: length and readability' },
    feasibility: { score: pre.feasibility, source: 'rule: does it need running infrastructure' },
    suitability: brainRecord
      ? { ...suitability(brainRecord), source: 'simulation: brain vote probability for "build"' }
      : { score: null, source: 'simulation: not asked (declined by policy first)' },
  };
}
