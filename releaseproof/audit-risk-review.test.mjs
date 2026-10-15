import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary} from './fixtures.mjs';
import {generateReview, renderHtml, canonicalJson, digest, escapeHtml} from './report.mjs';

// Invented synthetic evidence only; no private producer records or metadata.
const audits = ['dependencies_full', 'dependencies_production'];
const rowOf = (report, name) => report.findings.find(row => row.name === name);
const cells = (html, name) => {
  const row = html.match(new RegExp('<tr><td>' + name + '</td>[\\s\\S]*?</tr>'));
  assert.ok(row);
  return Array.from(row[0].matchAll(/<td>([\s\S]*?)<\/td>/g), match => match[1]);
};
const riskSection = html => html.split('<h2>Risk disposition</h2>')[1].split('<h2>Historical unknowns</h2>')[0];
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
  assert.deepEqual(report.historical_unknowns, ['diagnostic_artifact_capture_time', 'lifecycle_approval_configuration_comparison']);
};
function subset(summary) {
  const full = summary.results.dependencies_full;
  const production = summary.results.dependencies_production;
  production.findings = structuredClone(full.findings);
  production.findings.count = 2;
  production.findings.records = production.findings.records.slice(0, 2);
  production.findings.severity_counts.high = 2;
  production.findings.severity_counts.total = 2;
  production.command_exit = 1;
}
const risk = expected => ({status: 'ACCEPTED', scope: 'contest-only', project: expected.project,
  sha: expected.sha, pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: ['GHSA-example-synthetic']});

for (const name of audits) {
  test('rejects positive ' + name + ' findings with no advisory IDs', () => {
    const {packet, expected} = fixture();
    replaceSummary(packet, summary => { subset(summary); summary.results[name].findings.advisory_ids = []; });
    assert.throws(() => generateReview(packet, expected), /nonzero audit findings require advisory IDs/);
  });
  test('accepts one advisory for multiple package records in ' + name, () => {
    const {packet, expected} = fixture(); replaceSummary(packet, subset);
    const report = generateReview(packet, expected); const row = rowOf(report, name);
    assert.ok(row.records.length > row.advisory_ids.length);
    assert.deepEqual(row.advisory_ids, ['GHSA-example-synthetic']);
    retained(report);
  });
  test('retains zero-findings rejection of advisory IDs in ' + name, () => {
    const {packet, expected} = fixture({findings: false});
    replaceSummary(packet, summary => { summary.results[name].findings.advisory_ids = ['GHSA-invented-zero']; });
    assert.throws(() => generateReview(packet, expected), /zero audit findings must not contain advisory IDs/);
  });
}
test('zero dependency findings with empty advisory lists remain valid', () => {
  const {packet, expected} = fixture({findings: false}); const report = generateReview(packet, expected);
  for (const name of audits) assert.deepEqual(rowOf(report, name).advisory_ids, []);
  assert.equal(report.qc_verdict, 'NO_FINDINGS_IN_SUPPLIED_COVERAGE');
  assert.equal(report.human_release.approved, false);
});
test('multiple advisories do not need a one-to-one relationship with package records', () => {
  const {packet, expected} = fixture();
  replaceSummary(packet, summary => { summary.results.dependencies_full.findings.advisory_ids.push('GHSA-invented-second'); });
  const report = generateReview(packet, expected);
  assert.equal(rowOf(report, 'dependencies_full').records.length, 5);
  assert.equal(rowOf(report, 'dependencies_full').advisory_ids.length, 2);
  retained(report);
});

for (const [full, production, accepted] of [[0, 0, true], [1, 1, true], [2, 1, true], [2, 2, true], [5, 2, true], [0, 1, false], [1, 2, false]]) {
  test('matching snapshots compare target counts ' + full + '/' + production, () => {
    const {packet, expected} = fixture();
    replaceSummary(packet, summary => {
      subset(summary); summary.results.dependencies_full.findings.target_count = full;
      summary.results.dependencies_production.findings.target_count = production;
    });
    if (!accepted) { assert.throws(() => generateReview(packet, expected), /production target findings contradict comparable full audit/); return; }
    const report = generateReview(packet, expected);
    assert.equal(report.audit_comparison.status, 'SUBSET_CONFIRMED');
    assert.equal(rowOf(report, audits[0]).target_count, full); assert.equal(rowOf(report, audits[1]).target_count, production);
    retained(report);
  });
}
for (const [full, production] of [[undefined, undefined], [0, undefined], [undefined, 1], [undefined, 0]]) {
  test('matching snapshots preserve absent versus zero targets ' + full + '/' + production, () => {
    const {packet, expected} = fixture();
    replaceSummary(packet, summary => {
      subset(summary);
      if (full !== undefined) summary.results.dependencies_full.findings.target_count = full;
      if (production !== undefined) summary.results.dependencies_production.findings.target_count = production;
    });
    const report = generateReview(packet, expected); const saved = JSON.parse(canonicalJson(report)); const html = renderHtml(report);
    for (const [name, value] of [[audits[0], full], [audits[1], production]]) {
      assert.equal(Object.hasOwn(rowOf(saved, name), 'target_count'), value !== undefined);
      assert.equal(rowOf(saved, name).target_count, value);
      assert.equal(cells(html, name)[4], value === undefined ? 'Not supplied' : String(value));
    }
    assert.equal(report.audit_comparison.status, 'SUBSET_CONFIRMED'); retained(report);
  });
}
for (const scenario of ['missing full', 'missing production', 'missing both', 'different lockfile', 'different advisory snapshot']) {
  test('does not infer target-count comparability with ' + scenario, () => {
    const {packet, expected} = fixture();
    replaceSummary(packet, summary => {
      subset(summary); const full = summary.results.dependencies_full; const production = summary.results.dependencies_production;
      full.findings.target_count = 0; production.findings.target_count = 1;
      if (scenario === 'missing full' || scenario === 'missing both') delete full.snapshot;
      if (scenario === 'missing production' || scenario === 'missing both') delete production.snapshot;
      if (scenario === 'different lockfile') production.snapshot.lockfile_sha256 = 'f'.repeat(64);
      if (scenario === 'different advisory snapshot') production.snapshot.advisory_snapshot_sha256 = 'f'.repeat(64);
    });
    const report = generateReview(packet, expected);
    assert.equal(report.audit_comparison.status, scenario.startsWith('missing') ? 'NOT_ESTABLISHED' : 'DIFFERENT_SNAPSHOTS');
    assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
    assert.equal(rowOf(report, audits[0]).target_count, 0); assert.equal(rowOf(report, audits[1]).target_count, 1);
    retained(report);
  });
}

for (const [name, exit] of [['sast', 'Not applicable'], ['secrets', 'Not applicable'], ['dependencies_full', '1'], ['dependencies_production', '0']]) {
  test('HTML shows separate dependency command exit for ' + name, () => {
    const {packet, expected} = fixture(); const report = generateReview(packet, expected); const html = renderHtml(report);
    assert.ok(html.includes('<th>Dependency command exit</th>'));
    const values = cells(html, name);
    assert.equal(values[1], 'SUCCEEDED'); assert.equal(values[8], exit);
    if (name.startsWith('dependencies_')) assert.equal(rowOf(report, name).command_exit, Number(exit));
    else assert.equal(Object.hasOwn(rowOf(report, name), 'command_exit'), false);
    retained(report);
  });
}
test('HTML preserves numeric zero for both zero-finding audit command exits', () => {
  const {packet, expected} = fixture({findings: false}); const report = generateReview(packet, expected); const html = renderHtml(report);
  for (const name of audits) { assert.equal(rowOf(report, name).command_exit, 0); assert.equal(cells(html, name)[8], '0'); }
});
test('HTML preserves numeric one for both completed audits with findings', () => {
  const {packet, expected} = fixture(); replaceSummary(packet, subset);
  const report = generateReview(packet, expected); const html = renderHtml(report);
  for (const name of audits) { assert.equal(rowOf(report, name).command_exit, 1); assert.equal(cells(html, name)[8], '1'); }
  retained(report);
});
test('HTML command exit text uses the existing escaper', () => {
  const {packet, expected} = fixture(); const report = generateReview(packet, expected);
  // Renderer defense only: generator validation still accepts only numeric 0/1.
  const value = '<script>invented & "exit"</script>\r'; rowOf(report, audits[0]).command_exit = value;
  const html = renderHtml(report); assert.equal(cells(html, audits[0])[8], escapeHtml(value)); assert.ok(!html.includes('<script>'));
});

for (const scenario of ['active', 'expired', 'unbound']) test('HTML states record authenticity without changing ' + scenario + ' risk bounds', () => {
  const {packet, expected} = fixture(); expected.owner_disposition = risk(expected);
  if (scenario === 'expired') expected.owner_disposition.expires_at = expected.reviewed_at;
  if (scenario === 'unbound') delete expected.owner_disposition.pipeline;
  const supplied = structuredClone(expected.owner_disposition); const report = generateReview(packet, expected);
  const before = canonicalJson(report); const decision = report.owner_risk_disposition; const html = renderHtml(report); const section = riskSection(html);
  assert.equal(canonicalJson(report), before); assert.deepEqual(expected.owner_disposition, supplied);
  assert.equal(decision.status, {active: 'RECORDED_ACCEPTANCE', expired: 'EXPIRED', unbound: 'UNBOUND_PIPELINE'}[scenario]);
  for (const field of ['scope', 'expires_at', 'advisory_ids']) assert.deepEqual(decision[field], supplied[field]);
  assert.equal(decision.supplied_status, 'ACCEPTED'); assert.equal(decision.pipeline, supplied.pipeline ?? null);
  assert.equal(decision.authenticity, 'HUMAN_SUPPLIED_RECORD_NOT_AUTHENTICATED_BY_THIS_REPORT');
  assert.ok(section.includes('<dt>Record authenticity</dt><dd>' + decision.authenticity + '</dd>'));
  assert.ok(section.includes('The supplied owner record is not authenticated by this report.'));
  assert.ok(section.includes('does not change the QC verdict or grant release approval'));
  assert.ok(section.includes(decision.status) && section.includes(supplied.scope) && section.includes(supplied.expires_at));
  assert.equal(decision.grants_release, false); retained(report);
});
test('absent disposition does not invent a supplied record or authenticity declaration', () => {
  const {packet, expected} = fixture(); const report = generateReview(packet, expected); const section = riskSection(renderHtml(report));
  assert.equal(report.owner_risk_disposition.status, 'NOT_SUPPLIED');
  assert.equal(Object.hasOwn(report.owner_risk_disposition, 'authenticity'), false);
  assert.ok(!section.includes('<dt>Record authenticity</dt>') && !section.includes('The supplied owner record'));
  retained(report);
});
test('HTML escapes the retained disposition authenticity field', () => {
  const {packet, expected} = fixture(); expected.owner_disposition = risk(expected); const report = generateReview(packet, expected);
  const value = '<script>invented & "record"</script>\r'; report.owner_risk_disposition.authenticity = value;
  const section = riskSection(renderHtml(report));
  assert.ok(section.includes('<dt>Record authenticity</dt><dd>' + escapeHtml(value) + '</dd>')); assert.ok(!section.includes('<script>'));
});

function cliCase(source, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-audit-risk-'));
  try {
    const expectedPath = path.join(directory, 'expected.json'); const packetPath = path.join(directory, 'packet.json');
    const original = [Buffer.from(JSON.stringify(source.expected)), Buffer.from(JSON.stringify(source.packet))];
    fs.writeFileSync(expectedPath, original[0]); fs.writeFileSync(packetPath, original[1]);
    const output = path.join(directory, 'output'); const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', expectedPath, '--packet', packetPath, '--out', output], {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.deepEqual(fs.readFileSync(expectedPath), original[0]); assert.deepEqual(fs.readFileSync(packetPath), original[1]);
    check(result, output);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
for (const problem of ['missing advisories', 'contradictory target counts']) test('CLI rejects ' + problem + ' without outputs or input changes', () => {
  const source = fixture();
  replaceSummary(source.packet, summary => {
    subset(summary);
    if (problem === 'missing advisories') summary.results.dependencies_production.findings.advisory_ids = [];
    else { summary.results.dependencies_full.findings.target_count = 0; summary.results.dependencies_production.findings.target_count = 1; }
  });
  cliCase(source, (result, output) => {
    assert.equal(result.status, 2); assert.match(result.stderr, /nonzero audit findings require advisory IDs|production target findings contradict comparable full audit/);
    assert.equal(fs.existsSync(output), false);
  });
});
test('CLI retains producer metadata, raw-byte receipts and risk limits with corrected audit rendering', () => {
  const source = fixture({sourceKind: 'trace-derived'}); source.expected.owner_disposition = risk(source.expected);
  replaceSummary(source.packet, summary => {
    subset(summary);
    for (const result of Object.values(summary.results)) result.execution.issues = [];
    summary.results.sast.execution.target_exit = 0; summary.results.sast.findings.details = [];
    for (const scan of ['sast', 'secrets']) for (const kind of ['analyzer', 'scanner']) summary.results[scan][kind] = {
      id: 'invented-' + scan + '-' + kind, name: 'Invented <& tool', url: 'https://invented.example.invalid/<&', vendor: {name: 'Invented vendor'}, version: '0-synthetic'};
    summary.results.dependencies_full.findings.target_count = 0; summary.results.dependencies_production.findings.target_count = 1;
    for (const name of audits) delete summary.results[name].snapshot;
  });
  const raw = ' \r\n' + JSON.stringify(JSON.parse(source.packet.qc_summary_raw), null, 2) + '\r\n'; source.packet.qc_summary_raw = raw;
  source.packet.provenance.qc_summary.sha256 = digest(raw); source.packet.provenance.qc_summary.byte_count = Buffer.byteLength(raw, 'utf8');
  cliCase(source, (result, output) => {
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8')); const html = fs.readFileSync(path.join(output, 'review.html'), 'utf8');
    assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY'); assert.equal(report.provenance_status, 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE');
    const receipt = report.artifacts.find(receipt => receipt.path === 'qc-summary.json');
    assert.equal(receipt.sha256, digest(raw)); assert.equal(receipt.byte_count, Buffer.byteLength(raw, 'utf8'));
    assert.equal(rowOf(report, 'sast').target_exit, 0); assert.deepEqual(rowOf(report, 'sast').details, []);
    assert.equal(rowOf(report, 'sast').analyzer.name, 'Invented <& tool'); assert.ok(html.includes('Invented &lt;&amp; tool'));
    for (const name of audits) assert.equal(cells(html, name)[8], '1');
    assert.ok(riskSection(html).includes(report.owner_risk_disposition.authenticity)); retained(report);
  });
});
