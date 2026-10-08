import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxBuild, validateHtml } from '../src/site.js';
import { templateGenerate, validateSpec } from '../src/generator.js';
import { logoPng, bannerSvg } from '../src/art.js';

const brain = { networks: { reward: 1, visual: 0.4 }, vote: { reason: 'r', spiking: { used: false }, options: [{ label: 'build: x', p: 0.7 }] } };
const idea = { title: 'Ramen Radar', concept: 'A map of late-night ramen in Tokyo, hand drawn.', name_suggestion: null, ticker_suggestion: null };
const context = { preview: true, launched: false, submitter: 'So1ana', generatorLabel: 'a fixed template', links: [{ href: 'https://subzerone.live', label: 'room' }] };

test('sandboxed build produces a page that passes the safety check', async () => {
  const { spec } = templateGenerate({ idea, brain });
  const html = await sandboxBuild({ spec, context });
  assert.match(html, /Ramen Radar/);
  assert.deepEqual(validateHtml(html, ['https://subzerone.live']), { ok: true, problems: [] });
});

test('hostile text in the spec is escaped, never markup', async () => {
  const { spec } = templateGenerate({ idea, brain });
  spec.sections[0].body = '"><img src=x onerror=alert(1)> </p><script>steal()</script>';
  const html = await sandboxBuild({ spec, context });
  assert.ok(!html.includes('<script>steal'));
  assert.ok(!/<img src=x/.test(html));
  assert.equal(validateHtml(html, ['https://subzerone.live']).ok, true);
});

test('validator accepts harmless words in attribute text (review #9)', async () => {
  const { spec } = templateGenerate({ idea, brain });
  spec.description = 'a javascript: joke with style= and onboard=x in it';
  spec.name = 'Hop onboard=x';
  const html = await sandboxBuild({ spec, context });
  assert.deepEqual(validateHtml(html, ['https://subzerone.live']).problems, []);
});

test('validator rejects unsafe generated code', () => {
  for (const bad of ['<script>x</script>', '<img src=x>', '<p style="color:red">', '<img src="./logo.png" onerror="x">', '<a href="javascript:alert(1)">', '<iframe src="https://evil">',
    '<a href="https://evil.example">x</a>', '<div style="background:url(https://evil)">', '<meta http-equiv="refresh" content="0">']) {
    assert.equal(validateHtml(`<html>${bad}</html>`, ['https://subzerone.live']).ok, false, bad);
  }
});

test('the build process has no secrets and cannot read files or spawn processes', () => {
  const probe = `
    const out = { env: Object.keys(process.env).filter((k) => !k.startsWith('__CF')).length };  // macOS adds __CF_USER_TEXT_ENCODING
    try { require('node:fs').readFileSync('/etc/hosts'); out.read = true; } catch { out.read = false; }
    try { require('node:child_process').execSync('echo hi'); out.spawn = true; } catch { out.spawn = false; }
    try { require('node:fs').writeFileSync('/tmp/lp-sandbox-probe', 'x'); out.write = true; } catch { out.write = false; }
    console.log(JSON.stringify(out));`;
  const file = join(import.meta.dirname, 'fixtures-probe.cjs');
  writeFileSync(file, probe);
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${file}`, '--disable-warning=ExperimentalWarning', file], { env: {}, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out, { env: 0, read: false, spawn: false, write: false });
});

test('the build is killed at its time limit', async () => {
  const { spec } = templateGenerate({ idea, brain });
  await assert.rejects(sandboxBuild({ spec, context }, { timeoutMs: 1 }), /site build failed/);
});

test('spec validation refuses markup, financial promises and the SUB-01 ticker', () => {
  const { spec } = templateGenerate({ idea, brain });
  assert.throws(() => validateSpec({ ...spec, tagline: '<b>hi</b>' }));
  assert.throws(() => validateSpec({ ...spec, description: 'guaranteed returns for every holder' }));
  assert.throws(() => validateSpec({ ...spec, ticker: 'SUB01' }));
});

test('art is deterministic and drawn from the brain record', () => {
  const a = logoPng({ networks: brain.networks, seed: 's', size: 64 });
  const b = logoPng({ networks: brain.networks, seed: 's', size: 64 });
  assert.ok(a.equals(b));
  assert.equal(a.subarray(1, 4).toString(), 'PNG');
  const svg = bannerSvg({ name: '<x>', ticker: 'T', tagline: '"', networks: brain.networks, seed: 's' });
  assert.ok(!svg.includes('<x>'));
});
