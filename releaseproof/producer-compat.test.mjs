import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';
import {generateReview, renderHtml, canonicalJson, digest, escapeHtml} from './report.mjs';

// All identities, metadata and records in this file are invented.
const scans = ['sast', 'secrets'];
const names = [...scans, 'dependencies_full', 'dependencies_production'];
const kinds = ['analyzer', 'scanner'];
const metadata = (scan, kind) => ({id: 'invented-' + scan + '-' + kind,
  name: 'Synthetic ' + kind, url: 'https://tools.example.invalid/' + scan + '/' + kind,
  vendor: {name: 'Invented tools'}, version: '0.0.0-synthetic'});
function producer() {
  const source = fixture({sourceKind: 'trace-derived'});
  replaceSummary(source.packet, summary => {
    for (const name of names) summary.results[name].execution.issues = [];
    summary.results.sast.execution.target_exit = 0;
    summary.results.sast.findings.details = [];
    for (const scan of scans) for (const kind of kinds) summary.results[scan][kind] = metadata(scan, kind);
    // A shared job does not justify inventing comparable audit snapshots.
    for (const name of names.slice(2)) delete summary.results[name].snapshot;
  });
  source.packet.model = modelFixture(); delete source.packet.model.source.input_sha;
  source.expected.owner_disposition = {status: 'ACCEPTED', scope: 'contest-only',
    project: source.expected.project, sha: source.expected.sha, expires_at: '2026-11-16T23:59:59Z',
    advisory_ids: ['GHSA-example-synthetic']};
  return source;
}
const rowOf = (report, name) => report.findings.find(row => row.name === name);
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
  assert.equal(report.audit_comparison.status, 'NOT_ESTABLISHED');
  assert.equal(report.provenance_status, 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE');
  assert.equal(report.owner_risk_disposition.status, 'UNBOUND_PIPELINE');
  assert.equal(report.owner_risk_disposition.supplied_status, 'ACCEPTED');
  assert.equal(report.owner_risk_disposition.grants_release, false);
  assert.equal(report.model_note.source.input_sha, null);
  assert.deepEqual(report.historical_unknowns, ['diagnostic_artifact_capture_time', 'lifecycle_approval_configuration_comparison']);
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
};
test('producer-shaped summary preserves metadata and all review limitations', () => {
  const {packet, expected} = producer();
  const original = JSON.stringify({packet, expected});
  const report = generateReview(packet, expected);
  for (const name of names) assert.deepEqual(rowOf(report, name).execution_issues, []);
  assert.equal(rowOf(report, 'sast').target_exit, 0);
  assert.deepEqual(rowOf(report, 'sast').details, []);
  for (const scan of scans) for (const kind of kinds) assert.deepEqual(rowOf(report, scan)[kind], metadata(scan, kind));
  assert.equal(JSON.stringify({packet, expected}), original);
  retained(report);
});
test('existing minimal inputs do not gain fabricated producer metadata', () => {
  const {packet, expected} = fixture();
  const report = generateReview(packet, expected);
  for (const row of report.findings) for (const key of ['execution_issues', 'target_exit', 'details', ...kinds]) assert.equal(Object.hasOwn(row, key), false);
  assert.ok(!renderHtml(report).includes('Producer execution and tool metadata'));
});

const optional = [
  ...names.map(name => [name + ' execution issues', summary => { summary.results[name].execution.issues = []; }]),
  ['sast target exit', summary => { summary.results.sast.execution.target_exit = 0; }],
  ['sast empty details', summary => { summary.results.sast.findings.details = []; }],
  ...scans.flatMap(scan => kinds.map(kind => [scan + ' ' + kind, summary => { summary.results[scan][kind] = metadata(scan, kind); }])),
];
for (const [label, change] of optional) test('accepts optional ' + label + ' independently', () => {
  const {packet, expected} = fixture(); replaceSummary(packet, change);
  assert.equal(generateReview(packet, expected).qc_verdict, 'FAILED_WITH_FINDINGS');
});

const malformedMetadata = [
  ['null object', () => null], ['array object', () => []],
  ['missing version', value => { delete value.version; return value; }],
  ['numeric id', value => ({...value, id: 17})],
  ['empty name', value => ({...value, name: ''})],
  ['blank version', value => ({...value, version: ' \r\n\t'})],
  ['oversized URL', value => ({...value, url: 'u'.repeat(2049)})],
  ['oversized vendor name', value => ({...value, vendor: {name: 'v'.repeat(257)}})],
  ['authority field', value => ({...value, release_approved: true})],
  ['nested vendor authority', value => ({...value, vendor: {...value.vendor, g0: 'APPROVED'}})],
  ['null vendor', value => ({...value, vendor: null})],
  ['missing vendor name', value => ({...value, vendor: {}})],
];
for (const scan of scans) for (const kind of kinds) for (const [label, change] of malformedMetadata) {
  test('rejects ' + scan + ' ' + kind + ' ' + label, () => {
    const {packet, expected} = producer();
    replaceSummary(packet, summary => { summary.results[scan][kind] = change(summary.results[scan][kind]); });
    assert.throws(() => generateReview(packet, expected), /tool metadata|tool vendor/);
  });
}
const metadataFields = [
  ['id', 256], ['name', 256], ['url', 2048], ['version', 256], ['vendor.name', 256],
];
for (const [field, max] of metadataFields) {
  const set = (tool, value) => { if (field === 'vendor.name') tool.vendor.name = value; else tool[field] = value; };
  test('preserves metadata ' + field + ' at its bound', () => {
    const {packet, expected} = producer(); const value = 'x'.repeat(max);
    replaceSummary(packet, summary => set(summary.results.sast.analyzer, value));
    const tool = rowOf(generateReview(packet, expected), 'sast').analyzer;
    assert.equal(field === 'vendor.name' ? tool.vendor.name : tool[field], value);
  });
  test('rejects metadata ' + field + ' beyond its bound', () => {
    const {packet, expected} = producer();
    replaceSummary(packet, summary => set(summary.results.sast.analyzer, 'x'.repeat(max + 1)));
    assert.throws(() => generateReview(packet, expected), /tool metadata/);
  });
}
for (const name of names) for (const value of [['synthetic incomplete execution'], [{release_approved: true}], null, {}, '']) {
  test('rejects unsuccessful or malformed execution issues for ' + name + ': ' + JSON.stringify(value), () => {
    const {packet, expected} = producer();
    replaceSummary(packet, summary => { summary.results[name].execution.issues = value; });
    assert.throws(() => generateReview(packet, expected), /execution issues/);
  });
}
for (const value of [1, -1, '0', null, false, [], {exit: 0}]) test('rejects nonzero or malformed target_exit: ' + JSON.stringify(value), () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => { summary.results.sast.execution.target_exit = value; });
  assert.throws(() => generateReview(packet, expected), /target execution/);
});
for (const value of [null, {}, '', 0, ['synthetic detail'], [{id: 'invented', release_approved: true}]]) test('rejects unsupported SAST details: ' + JSON.stringify(value), () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => { summary.results.sast.findings.details = value; });
  assert.throws(() => generateReview(packet, expected), /details: unsupported/);
});
test('does not accept empty details as a contract for nonzero SAST findings', () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => { summary.results.sast.findings.count = 1; summary.results.sast.findings.ids = ['invented-finding']; });
  assert.throws(() => generateReview(packet, expected), /details: unsupported/);
});
for (const name of names.slice(1)) for (const key of ['target_exit', 'details']) test('does not extend SAST-only ' + key + ' to ' + name, () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => { summary.results[name][key === 'details' ? 'findings' : 'execution'][key] = key === 'details' ? [] : 0; });
  assert.throws(() => generateReview(packet, expected), /unexpected field/);
});
for (const name of names.slice(2)) for (const kind of kinds) test('does not invent dependency ' + name + ' ' + kind + ' metadata', () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => { summary.results[name][kind] = metadata(name, kind); });
  assert.throws(() => generateReview(packet, expected), /unexpected field/);
});
for (const location of ['summary', 'results', 'result', 'execution', 'coverage', 'findings']) test('retains unknown authority rejection in producer-shaped ' + location, () => {
  const {packet, expected} = producer();
  replaceSummary(packet, summary => {
    const result = summary.results.sast;
    const target = {summary, results: summary.results, result, execution: result.execution, coverage: result.coverage, findings: result.findings}[location];
    target.release_approved = true;
  });
  assert.throws(() => generateReview(packet, expected), /unexpected field/);
});

test('metadata survives JSON and escaped HTML with whitespace, item boundaries and Unicode intact', () => {
  const {packet, expected} = producer();
  const supplied = [];
  replaceSummary(packet, summary => {
    for (const scan of scans) for (const kind of kinds) {
      const tool = summary.results[scan][kind];
      for (const [field] of metadataFields) {
        const value = scan + '-' + kind + '-' + field + ' <&"\'\r\n標本-é-e\u0301-🚀,one item'; supplied.push(value);
        if (field === 'vendor.name') tool.vendor.name = value; else tool[field] = value;
      }
    }
  });
  const report = generateReview(packet, expected);
  const json = JSON.parse(canonicalJson(report)); const html = renderHtml(report);
  for (const scan of scans) for (const kind of kinds) assert.deepEqual(rowOf(json, scan)[kind], JSON.parse(packet.qc_summary_raw).results[scan][kind]);
  for (const value of supplied) assert.ok(html.includes('<code class="evidence-text">' + escapeHtml(value) + '</code>'));
  assert.ok(!html.includes('\r'));
  assert.ok(html.includes('<dt>Execution issues</dt><dd><code class="evidence-text">[]</code>'));
  assert.ok(html.includes('<dt>Target exit</dt><dd><code class="evidence-text">0</code>'));
  assert.ok(html.includes('<dt>Finding details</dt><dd><code class="evidence-text">[]</code>'));
  retained(report);
});
test('producer URL evidence is inert even for unsafe schemes and HTML injection text', () => {
  const {packet, expected} = producer(); const url = 'javascript:alert("invented")<script>&\'';
  replaceSummary(packet, summary => { summary.results.secrets.scanner.url = url; });
  const report = generateReview(packet, expected); const html = renderHtml(report);
  assert.equal(rowOf(report, 'secrets').scanner.url, url);
  assert.ok(html.includes('<dt>URL (inert text)</dt><dd><code class="evidence-text">' + escapeHtml(url) + '</code>'));
  assert.ok(!/<a\b|href\s*=|<script\b/i.test(html));
});
test('producer normalization preserves raw summary bytes and digest relationship', () => {
  const {packet, expected} = producer();
  const raw = ' \r\n' + JSON.stringify(JSON.parse(packet.qc_summary_raw), null, 2) + '\r\n ';
  packet.qc_summary_raw = raw;
  packet.provenance.qc_summary.sha256 = digest(raw);
  packet.provenance.qc_summary.byte_count = Buffer.byteLength(raw, 'utf8');
  const provenance = structuredClone(packet.provenance);
  const report = generateReview(packet, expected);
  assert.equal(packet.qc_summary_raw, raw); assert.deepEqual(packet.provenance, provenance);
  const receipt = report.artifacts.find(receipt => receipt.path === 'qc-summary.json');
  assert.equal(receipt.sha256, digest(raw));
  assert.equal(receipt.byte_count, Buffer.byteLength(raw, 'utf8'));
  retained(report);
});
test('producer compatibility does not excuse a changed raw summary digest', () => {
  const {packet, expected} = producer(); packet.qc_summary_raw += ' ';
  packet.provenance.qc_summary.byte_count++;
  assert.throws(() => generateReview(packet, expected), /digest mismatch/);
});
test('CLI accepts synthetic producer fields without rewriting inputs or granting release', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-producer-'));
  try {
    const {packet, expected} = producer();
    const expectedPath = path.join(directory, 'expected.json'); const packetPath = path.join(directory, 'packet.json');
    const original = [Buffer.from(JSON.stringify(expected)), Buffer.from(JSON.stringify(packet))];
    fs.writeFileSync(expectedPath, original[0]); fs.writeFileSync(packetPath, original[1]);
    const output = path.join(directory, 'output');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', expectedPath, '--packet', packetPath, '--out', output], {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(expectedPath), original[0]); assert.deepEqual(fs.readFileSync(packetPath), original[1]);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
    assert.deepEqual(rowOf(report, 'sast').analyzer, metadata('sast', 'analyzer'));
    assert.ok(fs.readFileSync(path.join(output, 'review.html'), 'utf8').includes(metadata('secrets', 'scanner').url));
    retained(report);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
