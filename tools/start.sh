#!/usr/bin/env bash
# Container entry: the web server first (it applies the migrations), then one worker once /healthz answers.
# Starting both at once (src/dev.js) races the first migration on an empty volume. Exits when either process dies,
# so the platform's restart policy restarts the whole container.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
NODE="node --disable-warning=ExperimentalWarning"
PORT="${PORT:-8787}"

$NODE src/server.js &
SERVER=$!
for _ in $(seq 1 120); do
  kill -0 "$SERVER" 2>/dev/null || { echo "start: web server exited before it listened" >&2; exit 1; }
  if node -e "fetch('http://127.0.0.1:$PORT/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.5
done

# one-off maintenance that needs the migrated database (idempotent, never fatal)
$NODE scripts/refresh-site-credits.js || echo "start: refresh-site-credits failed (continuing)" >&2
$NODE scripts/backfill-site-tools.js || echo "start: backfill-site-tools failed (continuing)" >&2

$NODE src/worker.js &
WORKER=$!
trap 'kill -TERM "$SERVER" "$WORKER" 2>/dev/null; wait; exit 0' TERM INT
wait -n "$SERVER" "$WORKER"
echo "start: a process exited, stopping the container" >&2
kill -TERM "$SERVER" "$WORKER" 2>/dev/null
wait
exit 1
