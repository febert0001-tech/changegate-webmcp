import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DEMO_FILES, observeDemoFiles, renderDemoPage} from './demo-page.mjs';
import {runDemo} from './demo.mjs';

const temp = t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-page-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
};
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
const attempt = (id, exit_code, outcome) => ({id, exit_code, outcome, signal: null, spawn_error: null});
const completed = () => ({outcome: 'SYNTHETIC_DEMONSTRATION_PASSED', github: null,
  recovery_byte_identity_established: true,
  attempts: [attempt('negative', 2, 'SYNTHETIC_REQUIRED_ARTIFACT_REJECTED'), attempt('recovery', 0, 'SYNTHETIC_REPORT_GENERATED_WITH_FINDINGS')],
  recovery_boundary: {qc_verdict: 'FAILED_WITH_FINDINGS', provenance_status: 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE',
    synthetic_high_findings: 5, human_release: {status: 'PENDING', approved: false}, deployment: {authorized: false}}});

test('real successful bundle entry preserves observed exits, identities and release limits', t => {
  const root = path.join(temp(t), 'demo');
  const receipt = runDemo(root, {env: {GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'synthetic/test', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2'}});
  const html = read(root, 'index.html');
  assert.match(html, /SYNTHETIC DEMONSTRATION COMPLETED/);
  for (const marker of ['FAILED_WITH_FINDINGS', 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE', 'PENDING', 'deployment.authorized=false',
    'G0 OPEN / NOT APPROVED', 'G1 CLOSED', 'Five synthetic High', 'byte-identical to original', 'validation_exits_raw',
    'synthetic/test', '123', '<td class="evidence">2</td>', '<td class="evidence">0</td>']) assert.ok(html.includes(marker), marker);
  for (const identity of Object.values(receipt.inputs)) assert.ok(html.includes(identity.sha256));
  assert.deepEqual(hrefs(html), DEMO_FILES.filter(name => hrefs(html).includes(name)).sort((a, b) => hrefs(html).indexOf(a) - hrefs(html).indexOf(b)));
  for (const name of hrefs(html)) assert.ok(observeDemoFiles(root).has(name));
  assert.ok(!hrefs(html).some(name => name.startsWith('http')));
  assert.match(read(root, 'WALKTHROUGH.md'), /Open index.html first/);
});

test('fixed receipt and availability render deterministically without mutation', () => {
  const receipt = completed();
  const original = structuredClone(receipt);
  const files = new Set(DEMO_FILES);
  assert.equal(renderDemoPage(receipt, files), renderDemoPage(receipt, files));
  assert.deepEqual(receipt, original);
});

test('absent identity and absent artifacts stay explicitly unavailable', () => {
  const html = renderDemoPage({outcome: 'FAILED', github: null, attempts: []});
  assert.deepEqual(hrefs(html), []);
  assert.match(html, /Unavailable — no GitHub Actions identity/);
  assert.match(html, /recovery-output\/review.html — unavailable/);
  assert.match(html, /NOT RUN/);
  assert.match(html, /Recovery boundary unavailable/);
  assert.match(html, /Not established; do not assume byte-identical/);
  assert.ok(!html.includes('Boundary recorded after successful demonstration'));
});

for (const change of [
  r => {r.outcome = 'FAILED'; r.failure = 'Synthetic failure';},
  r => {r.attempts.pop();},
  r => {r.attempts[1].exit_code = 2;},
  r => {r.attempts[1].spawn_error = 'ENOENT';},
  r => {r.attempts[1].signal = 'SIGTERM';},
  r => {delete r.recovery_boundary;},
  r => {delete r.recovery_byte_identity_established;},
]) test(`partial receipt never presents completed recovery: ${change}`, () => {
  const receipt = completed();
  change(receipt);
  const html = renderDemoPage(receipt, new Set(DEMO_FILES));
  assert.match(html, /FAILED \/ INCOMPLETE/);
  assert.match(html, /Recovery boundary unavailable/);
  assert.ok(!html.includes('SYNTHETIC DEMONSTRATION COMPLETED'));
});

test('missing report output prevents a completed recovery card even with a success receipt', () => {
  const html = renderDemoPage(completed(), new Set(DEMO_FILES.filter(name => name !== 'recovery-output/review.html')));
  assert.match(html, /Recovery boundary unavailable/);
  assert.ok(!hrefs(html).includes('recovery-output/review.html'));
});

test('malicious receipt strings are literal escaped evidence, never destinations or markup', () => {
  const attack = '<img src="https://evil.invalid/" onerror="alert(1)">&\'\r\n';
  const receipt = {outcome: attack, failure: attack, correction: attack,
    github: {repository: attack, sha: attack, run_id: attack, attempt: attack, url: 'javascript:alert(1)'},
    inputs: {valid: {path: '../../outside', sha256: attack, byte_count: attack}},
    attempts: [{id: 'negative', exit_code: null, signal: attack, spawn_error: attack,
      output_directory: 'https://evil.invalid/', output_files: [attack], outcome: attack}]};
  const html = renderDemoPage(receipt, new Set(['receipt.json', 'https://evil.invalid/', '../../outside']));
  assert.deepEqual(hrefs(html), ['receipt.json']);
  assert.ok(!/<img|<script|\sonerror="|\ssrc="/.test(html));
  assert.ok(html.includes('&lt;img src=&quot;https://evil.invalid/'));
  assert.ok(html.includes('&#13;\n'));
  assert.ok(html.includes('../../outside'));
  assert.ok(html.includes('javascript:alert(1)'));
});

test('observed availability excludes absent files, directories and symbolic links', t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'receipt.json'), '{}');
  fs.mkdirSync(path.join(root, 'negative.stdout'));
  fs.symlinkSync(path.join(root, 'receipt.json'), path.join(root, 'recovery.stderr'));
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere/packet.json'), '{}');
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'valid-input'));
  assert.deepEqual([...observeDemoFiles(root)], ['receipt.json']);
});

test('page retains offline CSP, semantic stages, captions, focus and responsive print rules', () => {
  const html = renderDemoPage(completed(), new Set(DEMO_FILES));
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.match(html, /<ol class="stages">/);
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /@media print/);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
  assert.ok(!/<script|<form|<iframe|<img|<link|\ssrc=|url\(/i.test(html));
});

for (const mode of ['producer-failed', 'negative-spawn-error', 'recovery-failed']) {
  test(`real runner retains partial page and original failure: ${mode}`, t => {
    const root = path.join(temp(t), 'demo');
    let call = 0;
    const spawn = (command, args, options) => {
      call++;
      if (call === 1 && mode === 'producer-failed') return {status: 1, signal: null};
      if (call === 2 && mode === 'negative-spawn-error') return {status: null, signal: null, error: {code: 'ENOENT'}};
      const result = spawnSync(command, args, options);
      return call === 3 && mode === 'recovery-failed' ? {...result, status: 2} : result;
    };
    assert.throws(() => runDemo(root, {spawn, env: {}}), /Demo process failure/);
    const receipt = JSON.parse(read(root, 'receipt.json'));
    const html = read(root, 'index.html');
    assert.equal(receipt.outcome, 'FAILED');
    assert.match(html, /FAILED \/ INCOMPLETE/);
    assert.match(html, /Recovery boundary unavailable/);
    assert.ok(!html.includes('SYNTHETIC DEMONSTRATION COMPLETED'));
    if (mode === 'negative-spawn-error') assert.match(html, /ENOENT/);
    if (mode === 'producer-failed') assert.ok(!hrefs(html).includes('valid-input/packet.json'));
    for (const name of hrefs(html)) assert.ok(observeDemoFiles(root).has(name));
  });
}

for (const failDemo of [true, false]) test(`entry write failure retains evidence and ${failDemo ? 'preserves primary' : 'propagates presentation'} failure`, t => {
  const root = path.join(temp(t), 'demo');
  let call = 0;
  const spawn = (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (++call === 2) fs.mkdirSync(path.join(root, 'index.html'));
    if (call === 2 && failDemo) return {...result, status: 1};
    return result;
  };
  assert.throws(() => runDemo(root, {spawn, env: {}}), failDemo ? /Demo process failure: expected exit 2, observed 1/ : /EEXIST/);
  const receipt = JSON.parse(read(root, 'receipt.json'));
  assert.equal(receipt.outcome, failDemo ? 'FAILED' : 'SYNTHETIC_DEMONSTRATION_PASSED');
  assert.ok(fs.existsSync(path.join(root, 'negative.stderr')));
  assert.match(read(root, 'WALKTHROUGH.md'), /index.html/);
  if (failDemo) assert.match(receipt.failure, /expected exit 2, observed 1/);
});

test('completed receipt in memory cannot complete a bundle without retained receipt.json', () => {
  const html = renderDemoPage(completed(), new Set(DEMO_FILES.filter(name => name !== 'receipt.json')));
  assert.match(html, /FAILED \/ INCOMPLETE/);
  assert.match(html, /receipt.json — unavailable/);
  assert.match(html, /Recovery boundary unavailable/);
  assert.ok(!html.includes('SYNTHETIC DEMONSTRATION COMPLETED'));
});

test('receipt retention failure propagates while writable entry page stays incomplete', t => {
  const root = path.join(temp(t), 'demo');
  let call = 0;
  const spawn = (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (++call === 3) fs.mkdirSync(path.join(root, 'receipt.json'));
    return result;
  };
  assert.throws(() => runDemo(root, {spawn, env: {}}), /EEXIST/);
  assert.equal(call, 3);
  const html = read(root, 'index.html');
  assert.match(html, /FAILED \/ INCOMPLETE/);
  assert.match(html, /receipt.json — unavailable/);
  assert.match(html, /Recovery boundary unavailable/);
  assert.ok(!html.includes('SYNTHETIC DEMONSTRATION COMPLETED'));
  assert.ok(!hrefs(html).includes('receipt.json'));
  assert.match(read(root, 'recovery.stdout'), /Report generated: FAILED_WITH_FINDINGS/);
  assert.ok(fs.existsSync(path.join(root, 'recovery-output/review.json')));
  assert.ok(fs.existsSync(path.join(root, 'recovery-output/review.html')));
  assert.match(read(root, 'WALKTHROUGH.md'), /index.html/);
  assert.match(html, /deployment.authorized=false/);
});

for (const stopAt of [1, 2]) test(`introduction describes intent when attempt ${stopAt} fails before recovery`, t => {
  const root = path.join(temp(t), 'demo');
  let call = 0;
  const spawn = (command, args, options) => {
    if (++call === stopAt) return {status: 1, signal: null};
    return spawnSync(command, args, options);
  };
  assert.throws(() => runDemo(root, {spawn, env: {}}), /Demo process failure/);
  assert.equal(call, stopAt);
  const receipt = JSON.parse(read(root, 'receipt.json'));
  assert.equal(receipt.outcome, 'FAILED');
  assert.ok(!receipt.attempts.some(item => item.id === 'recovery'));
  const html = read(root, 'index.html');
  const header = html.split('<header>')[1].split('</header>')[0];
  assert.match(header, /Intended sequence: omit/);
  assert.match(header, /Observed process results below show which attempts actually ran/);
  assert.ok(!header.includes('is omitted'));
  assert.ok(!header.includes('then restored'));
  assert.match(html, /NOT RUN/);
  assert.match(html, /Recovery boundary unavailable/);
  assert.ok(!html.includes('SYNTHETIC DEMONSTRATION COMPLETED'));
  assert.ok(!hrefs(html).includes('recovery-output/review.html'));
});
