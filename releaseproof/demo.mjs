import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalJson, digest, renderHtml} from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const limitations = 'SYNTHETIC inputs and outcomes only. Report-generation recovery is not clean native QC, deployment verification, human approval or production release. G0 OPEN / NOT APPROVED; G1 CLOSED.';

export function requireExit(result, expected) {
  assert.ok(!result.error && result.signal === null && result.status === expected,
    `Demo process failure: expected exit ${expected}, observed ${result.status}, signal ${result.signal}, spawn error ${result.error?.code ?? 'none'}`);
}

export function verifyRecovery(report, html) {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.provenance_status, 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE');
  assert.ok(report.artifacts.every(item => item.source_kind === 'synthetic-fixture'));
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
  assert.equal(report.deployment.action, 'NONE');
  const full = report.findings.find(item => item.name === 'dependencies_full');
  assert.equal(full.severity_counts.high, 5);
  assert.equal(full.findings_count, 5);
  assert.deepEqual(full.records, Array.from({length: 5}, (_, i) => `synthetic-package-${i + 1}`));
  assert.equal(html, renderHtml(report));
  for (const text of ['<!doctype html>', 'High: 5', ...full.records, 'FAILED_WITH_FINDINGS',
    'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE', 'Human release approval is pending.']) assert.ok(html.includes(text));
}

export function runDemo(directory, {spawn = spawnSync, env = process.env} = {}) {
  const root = path.resolve(directory);
  // Exclusive root: never reuse old outputs or overwrite a previous attempt.
  fs.mkdirSync(root);
  const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes, {flag: 'wx'});
  const read = name => fs.readFileSync(path.join(root, name));
  const identity = name => ({path: name, sha256: digest(read(name)), byte_count: read(name).length});
  const receipt = {contract: 'releaseproof-synthetic-demo/v1', synthetic: true, outcome: 'FAILED',
    correction: 'Restore only required packet.validation_exits_raw from the original valid packet.',
    limitations, gates: {g0: 'OPEN / NOT APPROVED', g1: 'CLOSED'}, github: null, attempts: []};
  const invoke = (label, script, args) => {
    const result = spawn(process.execPath, [path.join(here, script), ...args], {encoding: null, timeout: 30000});
    write(`${label}.stdout`, result.stdout ?? Buffer.alloc(0));
    write(`${label}.stderr`, result.stderr ?? Buffer.alloc(0));
    const attempt = {synthetic: true, id: label, command: ['node', `releaseproof/${script}`, ...args.map(arg => path.isAbsolute(arg) ? path.relative(root, arg) : arg)],
      exit_code: result.status, signal: result.signal, spawn_error: result.error?.code ?? null,
      stdout: identity(`${label}.stdout`), stderr: identity(`${label}.stderr`)};
    receipt.attempts.push(attempt);
    return {result, attempt};
  };
  try {
    if (env.GITHUB_ACTIONS === 'true') {
      for (const name of ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.ok(env[name], `Missing Actions identity ${name}`);
      receipt.github = {repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
        url: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`};
    }
    const valid = path.join(root, 'valid-input');
    requireExit(invoke('producer', 'write-example.mjs', [valid]).result, 0);
    const validBytes = read('valid-input/packet.json');
    const expectedBytes = read('valid-input/expected.json');
    const negative = JSON.parse(validBytes);
    assert.equal(typeof negative.validation_exits_raw, 'string');
    delete negative.validation_exits_raw;
    write('negative-packet.json', canonicalJson(negative));
    const restored = {...negative, validation_exits_raw: JSON.parse(validBytes).validation_exits_raw};
    assert.deepEqual(restored, JSON.parse(validBytes));
    // Recovery uses the preserved original bytes, not a rewritten or weakened packet.
    write('recovery-packet.json', validBytes);
    receipt.inputs = {valid: identity('valid-input/packet.json'), expected: identity('valid-input/expected.json'),
      negative: identity('negative-packet.json'), recovery: identity('recovery-packet.json')};
    const attempt = (label, packet) => {
      const output = path.join(root, `${label}-output`);
      fs.mkdirSync(output);
      const execution = invoke(label, 'cli.mjs', ['--expected', path.join(valid, 'expected.json'), '--packet', path.join(root, packet), '--out', output]);
      execution.attempt.inputs = {expected: receipt.inputs.expected, packet: identity(packet)};
      execution.attempt.output_directory = `${label}-output`;
      execution.attempt.output_files = fs.readdirSync(output);
      return execution;
    };
    const rejection = attempt('negative', 'negative-packet.json');
    requireExit(rejection.result, 2);
    assert.deepEqual(rejection.attempt.output_files, []);
    assert.match(read('negative.stderr').toString('utf8'), /^packet: missing field\r?\n$/);
    rejection.attempt.outcome = 'SYNTHETIC_REQUIRED_ARTIFACT_REJECTED';
    const recovery = attempt('recovery', 'recovery-packet.json');
    requireExit(recovery.result, 0);
    const report = JSON.parse(read('recovery-output/review.json'));
    verifyRecovery(report, read('recovery-output/review.html').toString('utf8'));
    recovery.attempt.outputs = ['recovery-output/review.json', 'recovery-output/review.html'].map(identity);
    recovery.attempt.outcome = 'SYNTHETIC_REPORT_GENERATED_WITH_FINDINGS';
    assert.deepEqual(read('valid-input/packet.json'), validBytes);
    assert.deepEqual(read('valid-input/expected.json'), expectedBytes);
    assert.deepEqual(read('recovery-packet.json'), validBytes);
    receipt.outcome = 'SYNTHETIC_DEMONSTRATION_PASSED';
    receipt.recovery_boundary = {qc_verdict: report.qc_verdict, provenance_status: report.provenance_status,
      human_release: report.human_release, deployment: report.deployment, synthetic_high_findings: 5};
  } catch (error) {
    receipt.failure = error.message;
    throw error;
  } finally {
    write('receipt.json', canonicalJson(receipt));
    write('WALKTHROUGH.md', `# SYNTHETIC ReleaseProof judge walkthrough\n\n${limitations}\n\nObserved demo outcome: ${receipt.outcome}.\n\n1. Inspect valid-input/packet.json and the separate valid-input/expected.json; receipt.json records their exact byte counts and SHA-256 digests. All provider-like identities are invented fixture data, separate from actual GitHub execution identity.\n2. Compare negative-packet.json: only required validation_exits_raw is omitted; its provenance is retained. Inspect negative.stdout, negative.stderr and the negative attempt in receipt.json. Accepted rejection requires real exit 2, the missing-field diagnostic and an empty fresh negative-output directory. Spawn errors fail the demo.\n3. Inspect recovery-packet.json: it is byte-identical to the original valid packet. The single correction restores validation_exits_raw. The recovery is a separate invocation into recovery-output, with separate stdout/stderr and receipts.\n4. Open recovery-output/review.html and review.json. Successful generation requires exit 0, matching valid JSON/HTML, five visible synthetic High findings, FAILED_WITH_FINDINGS, incomplete synthetic provenance, pending human release and deployment.authorized=false.\n5. Check receipt.json outcome and actual Actions identity (null outside Actions). A failed runner exits nonzero and retains its failure receipt; never treat an incomplete attempt as successful evidence.\n\n${receipt.failure ? `Failure: ${receipt.failure}\n` : ''}`);
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runDemo(process.argv[2] ?? 'releaseproof-output/demo'); }
  catch (error) { console.error(`Synthetic demonstration failed: ${error.message}`); process.exitCode = 1; }
}
