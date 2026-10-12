#!/usr/bin/env bash
# The site kit's fonts (docs/DESIGN.md), made once from the pinned @fontsource packages and committed here, so the kit
# build (kit/build.mjs) needs no Python. Re-run only to change the glyph set or the axes:
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools==4.60.1 brotli==1.1.0 && PATH=/tmp/ft/bin:$PATH bash kit/fonts/subset.sh
# Inter (variable: opsz 14–32 = Inter Display at large sizes, wght limited to 400–800) and JetBrains Mono 400/700,
# both SIL OFL 1.1, cut to Latin-1 plus the punctuation, arrows and signs the kit prints.
set -euo pipefail
cd "$(dirname "$0")/../.."
U="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2197-2198,U+2212,U+2264-2265,U+2713,U+2717,U+00D7"
NM=node_modules; OUT=kit/fonts; TMP=$(mktemp -d)
pyftsubset "$NM/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2" --unicodes="$U" \
  --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk,tnum,case' --flavor=woff2 --output-file="$TMP/inter.woff2"
fonttools varLib.instancer "$TMP/inter.woff2" wght=400:800 -o "$TMP/inter.ttf"
pyftsubset "$TMP/inter.ttf" --unicodes='*' --layout-features='*' --flavor=woff2 --output-file="$OUT/inter-var.woff2"
for w in 400 700; do
  pyftsubset "$NM/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-$w-normal.woff2" --unicodes="$U" \
    --layout-features='kern,ccmp,locl,mark,mkmk,tnum,zero' --flavor=woff2 --output-file="$OUT/jetbrains-mono-$w.woff2"
done
rm -rf "$TMP"; ls -l "$OUT"/*.woff2
