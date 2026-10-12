// Builds the site kit (docs/SITE-KIT.md) into public/_kit/, which is committed: the server never runs a bundler and
// the container ships no build tools. `npm run build:kit`. Deterministic for pinned inputs.
//   site-kit.v1.js   the core (IIFE, deferred): tools, wallet connector, Motion (motion/mini) for the entrances
//   site-kit.v2.css  the shared stylesheet (docs/DESIGN.md) + the vendored fonts (fonts/); site-kit.v1.css frozen (kit/legacy)
//   vendor/*.js      ES modules the core imports lazily, only on sites whose tool needs them
//   LICENSES.txt     every bundled library's licence text; manifest.json: sizes and hashes (tests and the report)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LIBS } from '../src/tools.js';

const ROOT = join(import.meta.dirname, '..'), OUT = join(ROOT, 'public', '_kit'), NM = join(ROOT, 'node_modules');
const pkg = (name) => JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8'));
const PKG = { anime: 'animejs', motion: 'motion', leaflet: 'leaflet', tone: 'tone', kaplay: 'kaplay', uplot: 'uplot', qrcode: 'qrcode-generator', pq: '@noble/post-quantum' };
for (const [k, name] of Object.entries(PKG)) {
  const v = pkg(name).version;
  if (v !== LIBS[k].version) throw new Error(`${name} is ${v} in node_modules but tools.js LIBS pins ${LIBS[k].version}`);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'vendor'), { recursive: true });
mkdirSync(join(OUT, 'fonts'), { recursive: true });

const VENDOR = { anime: LIBS.anime.file, leaflet: LIBS.leaflet.file, leafletCss: LIBS.leaflet.css, tone: LIBS.tone.file, kaplay: LIBS.kaplay.file,
  uplot: LIBS.uplot.file, uplotCss: LIBS.uplot.css, qrcode: LIBS.qrcode.file, pq: LIBS.pq.file };
const common = { bundle: true, minify: true, target: ['es2020', 'chrome100', 'firefox100', 'safari15'], legalComments: 'eof', logLevel: 'warning', charset: 'utf8' };
// the holder tools (kit/src/tools/holder-tools.js): our own code, a chunk named by its content hash (vendor files are cached a year)
{
  const out = await build({ ...common, entryPoints: [join(ROOT, 'kit/src/tools/holder-tools.js')], format: 'esm', write: false });
  const code = out.outputFiles[0].contents;
  VENDOR.holderTools = `holder-tools.${createHash('sha256').update(code).digest('hex').slice(0, 10)}.js`;
  writeFileSync(join(OUT, 'vendor', VENDOR.holderTools), code);
}

// the idea app's interpreter (kit/app/*.js, docs/APP-COMPOSER.md): its own module next to the core, loaded only on
// sites that carry an app, cached like the core (a day) so the two never drift apart for long
await build({ ...common, entryPoints: [join(ROOT, 'kit/app/index.js')], outfile: join(OUT, 'site-app.v1.js'), format: 'esm', external: ['/_kit/*'] });
// the launch block (kit/launch/index.js, child-launch.js): the only kit module that asks a wallet to sign a transaction,
// loaded by the app module only on a site whose app launches coins
await build({ ...common, entryPoints: [join(ROOT, 'kit/launch/index.js')], outfile: join(OUT, 'site-launch.v1.js'), format: 'esm' });
await build({ ...common, entryPoints: [join(ROOT, 'kit/src/core.js')], outfile: join(OUT, 'site-kit.v1.js'), format: 'iife', external: ['/_kit/*'],
  define: { __VENDOR__: JSON.stringify(VENDOR) } });
for (const k of ['anime', 'leaflet', 'tone', 'kaplay', 'uplot', 'qrcode', 'pq']) {
  await build({ ...common, entryPoints: [join(ROOT, `kit/src/vendor/${k}.js`)], outfile: join(OUT, 'vendor', LIBS[k].file), format: 'esm' });
}
// v2 (2026-10-12, docs/DESIGN.md): the black-and-white Swiss redesign; new markup only (render-child.js). v1 is frozen
// as it was (kit/legacy/), with its Archivo fonts, so a site version built before v2 still looks as it was built.
await build({ ...common, entryPoints: [join(ROOT, 'kit/src/site-kit.css')], outfile: join(OUT, 'site-kit.v2.css'), loader: { '.css': 'css' }, external: ['/_kit/*'] });
copyFileSync(join(ROOT, 'kit/legacy/site-kit.v1.css'), join(OUT, 'site-kit.v1.css'));
for (const w of [400, 700, 800]) copyFileSync(join(ROOT, `kit/legacy/fonts/archivo-${w}.woff2`), join(OUT, 'fonts', `archivo-${w}.woff2`));
copyFileSync(join(NM, 'leaflet/dist/leaflet.css'), join(OUT, 'vendor', LIBS.leaflet.css));
copyFileSync(join(NM, 'uplot/dist/uPlot.min.css'), join(OUT, 'vendor', LIBS.uplot.css));
// the fonts (docs/DESIGN.md): subset once from the pinned @fontsource packages by kit/fonts/subset.sh and committed
for (const f of ['inter-var.woff2', 'jetbrains-mono-400.woff2', 'jetbrains-mono-700.woff2']) copyFileSync(join(ROOT, 'kit/fonts', f), join(OUT, 'fonts', f));

// LICENSES.txt: each package's own licence file, verbatim
// qrcode-generator ships no LICENSE file: its source header says "Copyright (c) 2009 Kazuhiko Arase … Licensed under the
// MIT license", so the standard MIT text with that line stands in (the header is quoted above it).
const MIT = (holder) => `MIT License\n\n${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const licenceFile = (name) => {
  const dir = join(NM, name); const f = readdirSync(dir).find((x) => /^licen[cs]e/i.test(x));
  if (f) return readFileSync(join(dir, f), 'utf8').trim();
  if (name === 'qrcode-generator') return `${readFileSync(join(dir, 'dist/qrcode.js'), 'utf8').split('\n').slice(0, 15).join('\n')}\n\n${MIT('Copyright (c) 2009 Kazuhiko Arase')}`;
  return null;
};
const parts = ['SUBZERONE site kit v1: third-party software bundled in /_kit/ (see docs/SITE-KIT.md, CREDITS).', ''];
for (const [k, name] of Object.entries(PKG)) {
  const p = pkg(name), text = licenceFile(name);
  if (!text) throw new Error(`no licence file in ${name}`);
  parts.push('='.repeat(78), `${LIBS[k].name} ${p.version} (${p.license}) ${LIBS[k].url}`, `bundled in: ${LIBS[k].file ? `vendor/${LIBS[k].file}` : 'site-kit.v1.js'}`, '-'.repeat(78), text, '');
}
// @noble/post-quantum's own dependencies, bundled into its vendor file (same author, MIT)
for (const name of ['@noble/hashes', '@noble/curves', '@noble/ciphers']) {
  const dir = existsSync(join(NM, '@noble/post-quantum/node_modules', name)) ? `@noble/post-quantum/node_modules/${name}` : name;
  if (!existsSync(join(NM, dir))) continue;
  const p = pkg(dir);
  parts.push('='.repeat(78), `${name} ${p.version} (${p.license}) bundled in: vendor/${LIBS.pq.file}`, '-'.repeat(78), licenceFile(dir), '');
}
for (const [name, files] of [['@fontsource-variable/inter', 'fonts/inter-var.woff2 (subset: kit/fonts/subset.sh)'], ['@fontsource/jetbrains-mono', 'fonts/jetbrains-mono-*.woff2 (subset: kit/fonts/subset.sh)'],
  ['@fontsource/archivo', 'fonts/archivo-*.woff2 (site-kit.v1.css only)']]) {
  const p = pkg(name);
  parts.push('='.repeat(78), `${name} ${p.version} (${p.license}) ${files}`, '-'.repeat(78), licenceFile(name), '');
}
writeFileSync(join(OUT, 'LICENSES.txt'), parts.join('\n'));

// manifest: what each file weighs, raw and gzipped
const files = {};
const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f !== 'manifest.json') {
  const b = readFileSync(p); files[p.slice(OUT.length + 1)] = { bytes: b.length, gzip: gzipSync(b, { level: 9 }).length, sha256: createHash('sha256').update(b).digest('hex') }; } } };
walk(OUT);
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ kit: 'v1', vendor: VENDOR, files }, null, 1)}\n`);
for (const [f, x] of Object.entries(files)) console.log(`${f.padEnd(34)} ${String(x.bytes).padStart(8)} B  gzip ${String(x.gzip).padStart(7)} B`);

