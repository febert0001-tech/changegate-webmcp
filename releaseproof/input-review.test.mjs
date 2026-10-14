import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';
import {generateReview, renderHtml} from './report.mjs';

const risk = (expected, advisory = 'GHSA-example-synthetic') => ({
  status: 'ACCEPTED', scope: 'contest-only', project: expected.project, sha: expected.sha,
  pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59.000Z', advisory_ids: [advisory],
});
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
  assert.ok(report.historical_unknowns.includes('diagnostic_artifact_capture_time'));
  assert.ok(report.historical_unknowns.includes('lifecycle_approval_configuration_comparison'));
};
function cliCase(source, change, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-input-review-'));
  try {
    const files = {expected: path.join(directory, 'expected.json'), packet: path.join(directory, 'packet.json')};
    const bytes = {expected: Buffer.from(JSON.stringify(source.expected)), packet: Buffer.from(JSON.stringify(source.packet))};
    change(bytes);
    fs.writeFileSync(files.expected, bytes.expected);
    fs.writeFileSync(files.packet, bytes.packet);
    const output = path.join(directory, 'output');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', files.expected, '--packet', files.packet, '--out', output],
      {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    for (const key of ['expected', 'packet']) assert.deepEqual(fs.readFileSync(files[key]), bytes[key], 'input bytes must not be rewritten');
    check({result, output});
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
for (const [name, malformed, replacements] of [
  ['invalid leading byte', [0xff], 1],
  ['lone continuation', [0x80], 1],
  ['incomplete sequence', [0xc3], 1],
  ['overlong sequence', [0xc0, 0xaf], 2],
  ['encoded surrogate', [0xed, 0xa0, 0x80], 3],
  ['code point above Unicode range', [0xf4, 0x90, 0x80, 0x80], 4],
]) {
  for (const key of ['expected', 'packet']) {
    test('CLI rejects ' + name + ' in ' + key + ' before replacement-text validation', () => {
      const source = fixture();
      const advisory = 'GHSA-synthetic-' + '\ufffd'.repeat(replacements) + '-advisory';
      replaceSummary(source.packet, summary => { summary.results.dependencies_full.findings.advisory_ids = [advisory]; });
      source.expected.owner_disposition = risk(source.expected, advisory);
      cliCase(source, bytes => {
        const replacementBytes = Buffer.from('\ufffd'.repeat(replacements));
        const offset = bytes[key].indexOf(replacementBytes);
        assert.ok(offset >= 0);
        bytes[key] = Buffer.concat([bytes[key].subarray(0, offset), Buffer.from(malformed), bytes[key].subarray(offset + replacementBytes.length)]);
        // Demonstrate that permissive decoding would validate substituted text.
        const substituted = JSON.parse(bytes[key].toString('utf8'));
        retained(generateReview(key === 'packet' ? substituted : source.packet, key === 'expected' ? substituted : source.expected));
      }, ({result, output}) => {
        assert.equal(result.status, 2);
        assert.equal(result.stderr, (key === 'expected' ? 'expectation' : 'packet') + ': invalid UTF-8\n');
        assert.equal(result.stdout, '');
        assert.equal(fs.existsSync(output), false);
      });
    });
  }
}
for (const unicode of ['標本-é-e\u0301-🚀', 'literal-\ufffd-replacement-character']) {
  test('CLI preserves valid Unicode exactly: ' + unicode, () => {
    const source = fixture();
    const record = '  synthetic-' + unicode + ' \t';
    const advisory = ' synthetic-advisory-' + unicode + ' ';
    replaceSummary(source.packet, summary => {
      summary.results.dependencies_full.findings.records[0] = record;
      summary.results.dependencies_full.findings.advisory_ids = [advisory];
    });
    source.expected.owner_disposition = risk(source.expected, advisory);
    source.packet.model = modelFixture();
    source.packet.model.text = unicode;
    cliCase(source, () => {}, ({result, output}) => {
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
      assert.equal(report.findings.find(row => row.name === 'dependencies_full').records[0], record);
      assert.deepEqual(report.owner_risk_disposition.advisory_ids, [advisory]);
      assert.equal(report.model_note.text, unicode);
      assert.ok(fs.readFileSync(path.join(output, 'review.html'), 'utf8').includes(unicode));
      retained(report);
    });
  });
}

function nonemptyProduction(summary) {
  const production = summary.results.dependencies_production;
  production.findings = structuredClone(summary.results.dependencies_full.findings);
  production.findings.records = production.findings.records.slice(0, 2);
  production.findings.count = 2;
  production.findings.severity_counts.high = 2;
  production.findings.severity_counts.total = 2;
  production.command_exit = 1;
}
const targets = [];
for (const name of ['dependencies_full', 'dependencies_production']) {
  for (const field of ['records', 'advisory_ids']) {
    targets.push([name + '.' + field, (summary, blank) => { summary.results[name].findings[field][0] = blank; }]);
  }
}
for (const name of ['sast', 'secrets']) {
  targets.push([name + '.ids', (summary, blank) => { summary.results[name].findings.count = 1; summary.results[name].findings.ids = [blank]; }]);
}
for (const [description, blank] of [['empty', ''], ['ASCII whitespace', ' \t\r\n'], ['Unicode whitespace', '\u00a0\u3000']]) {
  for (const [name, mutate] of targets) {
    test('rejects ' + description + ' evidence entry in ' + name, () => {
      const {expected, packet} = fixture();
      replaceSummary(packet, summary => { nonemptyProduction(summary); mutate(summary, blank); });
      assert.throws(() => generateReview(packet, expected), /blank entry/);
    });
  }
}
test('nonblank padded evidence is retained without trimming or normalization', () => {
  const {expected, packet} = fixture();
  const record = ' \tsynthetic-e\u0301-record \n';
  const advisory = '\tsynthetic-é-advisory ';
  replaceSummary(packet, summary => {
    summary.results.dependencies_full.findings.records[0] = record;
    summary.results.dependencies_full.findings.advisory_ids = [advisory];
  });
  expected.owner_disposition = risk(expected, advisory);
  const report = generateReview(packet, expected);
  assert.equal(report.findings.find(row => row.name === 'dependencies_full').records[0], record);
  assert.deepEqual(report.owner_risk_disposition.advisory_ids, [advisory]);
  retained(report);
});

const auditHtml = report => renderHtml(report).split('<h2>Audit comparability</h2>')[1].split('<h2>Risk disposition</h2>')[0];
test('HTML displays matching snapshot hashes under both audit names', () => {
  const {expected, packet} = fixture();
  const report = generateReview(packet, expected);
  const html = auditHtml(report);
  for (const name of ['dependencies_full', 'dependencies_production']) assert.ok(html.includes('<h3>' + name + '</h3>'));
  for (const hash of Object.values(report.audit_comparison.snapshot)) assert.equal(html.split(hash).length - 1, 2);
  assert.equal(report.audit_comparison.status, 'SUBSET_CONFIRMED');
});
function differingSnapshots(packet) {
  replaceSummary(packet, summary => {
    summary.results.dependencies_production.snapshot = {lockfile_sha256: 'f'.repeat(64), advisory_snapshot_sha256: '1'.repeat(64)};
  });
}
test('HTML displays both differing snapshot declarations without asserting comparability', () => {
  const {expected, packet} = fixture();
  differingSnapshots(packet);
  const report = generateReview(packet, expected);
  const html = auditHtml(report);
  for (const snapshot of report.audit_comparison.snapshots) {
    for (const hash of Object.values(snapshot)) assert.ok(html.includes(hash));
  }
  assert.equal(report.audit_comparison.status, 'DIFFERENT_SNAPSHOTS');
  assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
  retained(report);
});
for (const missing of ['dependencies_full', 'dependencies_production']) {
  test('HTML retains known snapshot hashes and unknown state when ' + missing + ' is absent', () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => { delete summary.results[missing].snapshot; });
    const report = generateReview(packet, expected);
    const html = auditHtml(report);
    assert.equal(report.audit_comparison.status, 'NOT_ESTABLISHED');
    assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
    assert.ok(html.includes('Snapshot identities not supplied.'));
    for (const snapshot of report.audit_comparison.snapshots.filter(Boolean)) {
      for (const hash of Object.values(snapshot)) assert.ok(html.includes(hash));
    }
    retained(report);
  });
}
test('HTML does not invent hashes when both audit snapshots are absent', () => {
  const {expected, packet} = fixture();
  replaceSummary(packet, summary => { delete summary.results.dependencies_full.snapshot; delete summary.results.dependencies_production.snapshot; });
  const report = generateReview(packet, expected);
  const html = auditHtml(report);
  assert.deepEqual(report.audit_comparison.snapshots, [null, null]);
  assert.equal(html.split('Snapshot identities not supplied.').length - 1, 2);
  assert.ok(!html.includes('Lockfile SHA-256') && !html.includes('Advisory snapshot SHA-256'));
  assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
});
for (const kind of ['matching', 'differing']) {
  test('HTML escapes snapshot fields for ' + kind + ' declarations', () => {
    const {expected, packet} = fixture();
    if (kind === 'differing') differingSnapshots(packet);
    const report = generateReview(packet, expected);
    // Renderer defense: this is not a claim that non-hex input hashes validate.
    const snapshot = kind === 'matching' ? report.audit_comparison.snapshot : report.audit_comparison.snapshots[1];
    snapshot.lockfile_sha256 = '"><img src=x onerror="synthetic">';
    snapshot.advisory_snapshot_sha256 = '<script>synthetic & \'hash\'</script>';
    const html = auditHtml(report);
    assert.ok(!html.includes('<img ') && !html.includes('<script>'));
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=&quot;synthetic&quot;&gt;'));
    assert.ok(html.includes('&lt;script&gt;synthetic &amp; &#39;hash&#39;&lt;/script&gt;'));
  });
}

for (const [name, reviewedAt, status] of [
  ['before', '2026-11-16T23:59:58.999Z', 'RECORDED_ACCEPTANCE'],
  ['at', '2026-11-16T23:59:59Z', 'EXPIRED'],
  ['after', '2026-11-16T23:59:59.001Z', 'EXPIRED'],
]) {
  test('pipeline-bound acceptance is ' + status + ' ' + name + ' its expiry instant', () => {
    const {expected, packet} = fixture();
    expected.owner_disposition = risk(expected);
    expected.reviewed_at = reviewedAt;
    const original = structuredClone(expected.owner_disposition);
    const report = generateReview(packet, expected);
    assert.equal(report.owner_risk_disposition.status, status);
    assert.equal(report.owner_risk_disposition.expires_at, original.expires_at);
    assert.equal(report.owner_risk_disposition.supplied_status, 'ACCEPTED');
    assert.deepEqual(expected.owner_disposition, original);
    assert.ok(renderHtml(report).includes(status));
    retained(report);
  });
}
