#!/usr/bin/env bash
# Deploy the launchpad (backend + the city client) to the Railway service `launchpad`.
#
#   tools/deploy-railway.sh            # tests both repos, builds the city, uploads, deploys (detached)
#   CITY_DIR=/path/to/sub01-launchpad tools/deploy-railway.sh
#   SKIP_CITY=1 tools/deploy-railway.sh  # backend-only change: reuse the city-dist/ of the last green city build
#
# Refuses when either test suite fails (with SKIP_CITY=1 the city is neither tested nor rebuilt; city-dist/ must exist). Uploads a staged copy that holds only what the Dockerfile needs, so the
# local .env, data/ and node_modules never leave this machine. Needs: the Railway CLI logged in, and this directory
# linked to the project (`railway link`), which `railway init` did once.
set -euo pipefail

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CITY_DIR="${CITY_DIR:-../sub01-launchpad}"   # the city client checkout (nocontentinhere4-art/sub01-launchpad)
SERVICE="${RAILWAY_SERVICE:-launchpad}"

command -v railway >/dev/null || { echo "railway CLI not installed" >&2; exit 1; }

if [ "${SKIP_CITY:-0}" = "1" ]; then
  echo "== city: SKIP_CITY=1, reusing $BACKEND/city-dist"
else
  [ -d "$CITY_DIR" ] || { echo "city repo not found: $CITY_DIR (set CITY_DIR)" >&2; exit 1; }
  echo "== city: tests + build ($CITY_DIR)"
  ( cd "$CITY_DIR"
    [ -d node_modules ] || npm ci
    npm test
    npx vite build )
fi

echo "== backend: tests ($BACKEND)"
( cd "$BACKEND" && LAUNCHPAD_NO_DOTENV=1 npm test )

if [ "${SKIP_CITY:-0}" != "1" ]; then
  echo "== city dist -> $BACKEND/city-dist"
  mkdir -p "$BACKEND/city-dist"
  rsync -a --delete "$CITY_DIR/dist/" "$BACKEND/city-dist/"
fi
[ -f "$BACKEND/city-dist/index.html" ] || { echo "no city build in $BACKEND/city-dist (run without SKIP_CITY)" >&2; exit 1; }

echo "== staging the upload"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/launchpad-deploy.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
( cd "$BACKEND"
  cp package.json package-lock.json Dockerfile railway.json .dockerignore "$STAGE/"
  mkdir -p "$STAGE/tools" && cp tools/start.sh "$STAGE/tools/"
  for d in src migrations public docs scripts city-dist; do rsync -a --exclude '*.bak*' --exclude '.DS_Store' "$d/" "$STAGE/$d/"; done )
# belt and braces: nothing secret or local may be in the staged tree
for forbidden in .env data node_modules test; do
  [ -e "$STAGE/$forbidden" ] && { echo "refusing to upload: $forbidden is in the staged tree" >&2; exit 1; }
done
echo "   $(du -sh "$STAGE" | cut -f1) staged"

# `railway up <path>` only accepts a path inside the linked directory, so upload from the staged tree itself and
# name the project/environment/service explicitly (the staged tree is not linked).
PROJECT_ID="$(cd "$BACKEND" && railway status --json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
echo "== railway up --project $PROJECT_ID --environment $ENVIRONMENT --service $SERVICE (detached)"
( cd "$STAGE" && railway up --project "$PROJECT_ID" --environment "$ENVIRONMENT" --service "$SERVICE" --detach --no-gitignore )
echo "== done; follow with: railway logs --service $SERVICE"
