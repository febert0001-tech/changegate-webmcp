import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runDemo, requireExit, verifyRecovery} from './demo.mjs';

const temporary = t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-synthetic-demo-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return path.join(root, 'demo');
};

test('real CLI rejection and recovery retain byte identities and release boundary', t => {
  const directory = temporary(t);
  const receipt = runDemo(directory, {env: {}});
  assert.equal(receipt.outcome, 'SYNTHETIC_DEMONSTRATION_PASSED');
  assert.equal(receipt.github, null);
  assert.equal(receipt.inputs.valid.sha256, receipt.inputs.recovery.sha256);
  assert.notEqual(receipt.inputs.valid.sha256, receipt.inputs.negative.sha256);
  assert.deepEqual(receipt.attempts.map(item => item.exit_code), [0, 2, 0]);
  const valid = JSON.parse(fs.readFileSync(path.join(directory, 'valid-input/packet.json')));
  const negative = JSON.parse(fs.readFileSync(path.join(directory, 'negative-packet.json')));
  delete valid.validation_exits_raw;
  assert.deepEqual(negative, valid);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'recovery-output/review.json')));
  const html = fs.readFileSync(path.join(directory, 'recovery-output/review.html'), 'utf8');
  for (const mutate of [r => {r.deployment.authorized = true;}, r => {r.human_release.approved = true;},
    r => {r.qc_verdict = 'PASSED';}, r => {r.provenance_status = 'NATIVE_BYTES_DECLARED';},
    r => {r.findings.find(row => row.name === 'dependencies_full').severity_counts.high = 0;}]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => verifyRecovery(changed, html));
  }
  assert.throws(() => runDemo(directory), /EEXIST/);
});

for (const failure of [
  {status: 2, signal: null, error: {code: 'ENOENT'}},
  {status: null, signal: 'SIGTERM'},
  {status: 0, signal: null},
  {status: 1, signal: null},
]) test(`process failure cannot masquerade as rejection: ${JSON.stringify(failure)}`, () => {
  assert.throws(() => requireExit(failure, 2));
});

for (const mode of ['spawn-error', 'unexpected-success', 'stale-output', 'recovery-failed']) {
  test(`runner propagates ${mode} and retains failure receipt`, t => {
    const directory = temporary(t);
    let call = 0;
    const spawn = (command, args, options) => {
      call++;
      if (call === 2 && mode === 'spawn-error') return {status: 2, signal: null, error: {code: 'ENOENT'}};
      if (call === 2 && mode === 'unexpected-success') return {status: 0, signal: null};
      const result = spawnSync(command, args, options);
      if (call === 2 && mode === 'stale-output') fs.writeFileSync(args.at(-1) + '/review.json', '{}');
      if (call === 3 && mode === 'recovery-failed') return {...result, status: 2};
      return result;
    };
    assert.throws(() => runDemo(directory, {spawn, env: {}}));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json')));
    assert.equal(receipt.outcome, 'FAILED');
    assert.ok(receipt.failure);
    assert.ok(fs.existsSync(path.join(directory, 'negative.stderr')));
    assert.ok(fs.existsSync(path.join(directory, 'WALKTHROUGH.md')));
    if (mode !== 'recovery-failed') assert.equal(call, 2);
  });
}
