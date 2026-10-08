#!/bin/sh
# Local development: run SUB-01's live server in demo mode with the launchpad's shared secret, so the launchpad's
# evaluations go through the real brain vote. SUB01_DIR: a checkout of the sub-01 repo with feature/launchpad-eval.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SUB01_DIR="${SUB01_DIR:-$HERE/../sub01-main}"
LAUNCHPAD_BRAIN_SECRET="$(grep '^LAUNCHPAD_BRAIN_SECRET=' "$HERE/.env" | cut -d= -f2-)"
export LAUNCHPAD_BRAIN_SECRET BROWSE=0 SUB01_SPIKING_LIVE=0
cd "$SUB01_DIR"
exec .venv/bin/python live_server.py --demo --start "${BRAIN_START:-14:00}" --data-dir "$SUB01_DIR/data/launchpad-demo" --port "${BRAIN_PORT:-8769}"
