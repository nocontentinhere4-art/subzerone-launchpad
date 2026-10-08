// Structured JSON logs on stdout. Sensitive fields are redacted by key name, at any depth.
const SENSITIVE = /secret|token|password|passwd|cookie|authorization|private|seed|mnemonic|signature|verifier|_enc$|apikey|api_key/i;

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

let sink = (line) => process.stdout.write(line + '\n');
export const setLogSink = (fn) => { sink = fn; };

function emit(level, msg, fields) {
  const f = fields instanceof Error ? { error: fields.message } : fields;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(f || {}) }));
}
export const log = {
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
};
