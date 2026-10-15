import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateReview, renderHtml, canonicalJson, digest, EvidenceError} from './report.mjs';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';

test('valid failed assessment retains five High findings and separate successful execution', () => {
  const {expected, packet} = fixture();
  const report = generateReview(packet, expected);
  assert.equal(report.consistency, 'PASSED');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.findings.find(row => row.name === 'dependencies_full').severity_counts.high, 5);
  assert.equal(report.findings.find(row => row.name === 'dependencies_full').command_exit, 1);
  assert.equal(report.command_execution.status, 'SUCCEEDED');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
});
test('identical inputs produce identical JSON and HTML bytes', () => {
  const {expected, packet} = fixture();
  const first = generateReview(packet, expected);
  const second = generateReview(structuredClone(packet), structuredClone(expected));
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(renderHtml(first), renderHtml(second));
});
test('native job ordering does not change deterministic outputs', () => {
  const {expected, packet} = fixture();
  const first = canonicalJson(generateReview(packet, expected));
  packet.native.jobs.reverse();
  assert.equal(first, canonicalJson(generateReview(packet, expected)));
});
test('zero findings require successful native assessment and preserve pending human release', () => {
  const {expected, packet} = fixture({findings: false});
  const report = generateReview(packet, expected);
  assert.equal(report.qc_verdict, 'NO_FINDINGS_IN_SUPPLIED_COVERAGE');
  assert.equal(report.human_release.status, 'PENDING');
});
for (const [name, mutate] of [
  ['wrong project', packet => { packet.native.project.id = 99; }],
  ['wrong commit', packet => { packet.native.commit.id = 'c'.repeat(40); }],
  ['wrong pipeline', packet => { packet.native.pipeline.id = 99; }],
  ['wrong job ID', packet => { packet.native.jobs[0].id = 99; }],
  ['wrong job commit', packet => { packet.native.jobs[0].commit.id = 'c'.repeat(40); }],
  ['wrong job project', packet => { packet.native.jobs[0].pipeline.project_id = 99; }],
  ['missing job', packet => { packet.native.jobs.pop(); }],
  ['duplicate job', packet => { packet.native.jobs[1] = structuredClone(packet.native.jobs[0]); }],
  ['skipped job', packet => { packet.native.jobs[0].status = 'skipped'; }],
  ['failed application execution', packet => { packet.native.jobs[0].status = 'failed'; }],
  ['failed scanner execution', packet => { packet.native.jobs[1].status = 'failed'; }],
  ['forged native success', packet => { packet.native.pipeline.status = 'success'; packet.native.jobs[4].status = 'success'; }],
  ['wrong artifact job', packet => { packet.provenance.qc_summary.job = '101'; }],
  ['wrong artifact path', packet => { packet.provenance.qc_summary.path = '../qc-summary.json'; }],
  ['tampered raw artifact', packet => { packet.qc_summary_raw += ' '; }],
  ['bad artifact byte count', packet => { packet.provenance.qc_summary.byte_count++; }],
  ['missing native receipt', packet => { delete packet.native.commit; }],
  ['missing artifact', packet => { delete packet.qc_summary_raw; }],
  ['forged packet release', packet => { packet.release_approval = {approved: true}; }],
  ['forged model approval', packet => { packet.model = {...modelFixture(), approved: true}; }],
  ['model claims current approval', packet => { packet.model = modelFixture(); packet.model.source.kind = 'release-approval'; }],
]) {
  test(`rejects ${name}`, () => {
    const {expected, packet} = fixture(); mutate(packet);
    assert.throws(() => generateReview(packet, expected), EvidenceError);
  });
}
for (const [name, change] of [
  ['wrong summary SHA', summary => { summary.sha = 'c'.repeat(40); }],
  ['wrong scan job', summary => { summary.results.sast.execution.job = '105'; }],
  ['incomplete scan coverage', summary => { summary.results.sast.coverage.status = 'INCOMPLETE'; }],
  ['coverage warning', summary => { summary.results.sast.coverage.issues.push('parse error'); }],
  ['hidden findings', summary => { summary.findings_present = false; }],
  ['wrong record count', summary => { summary.results.dependencies_full.findings.count = 4; }],
  ['wrong severity total', summary => { summary.results.dependencies_full.findings.severity_counts.total = 4; }],
  ['wrong audit exit', summary => { summary.results.dependencies_full.command_exit = 0; }],
  ['removed historical unknown', summary => { summary.historical_unknowns.pop(); }],
  ['invented historical waiver', summary => { summary.historical_audit_waiver = true; }],
  ['invented G0 approval', summary => { summary.g0 = 'APPROVED'; }],
]) {
  test(`rejects ${name} even with recomputed artifact digest`, () => {
    const {expected, packet} = fixture(); replaceSummary(packet, change);
    assert.throws(() => generateReview(packet, expected), EvidenceError);
  });
}
test('malformed JSON cannot produce a report even when its digest matches', () => {
  const {expected, packet} = fixture();
  packet.qc_summary_raw = '{'; packet.provenance.qc_summary.sha256 = digest('{'); packet.provenance.qc_summary.byte_count = 1;
  assert.throws(() => generateReview(packet, expected), /malformed JSON/);
});
test('nonzero application exit cannot become success', () => {
  const {expected, packet} = fixture();
  packet.validation_exits_raw = JSON.stringify({assessor: 0, tests: 1, typecheck: 0, lint: 0, build: 0});
  packet.provenance.validation_exits.sha256 = digest(packet.validation_exits_raw);
  packet.provenance.validation_exits.byte_count = Buffer.byteLength(packet.validation_exits_raw);
  assert.throws(() => generateReview(packet, expected), /application command failed/);
});
test('trace-derived inputs remain incomplete native-artifact provenance', () => {
  const {expected, packet} = fixture({sourceKind: 'trace-derived'});
  const report = generateReview(packet, expected);
  assert.equal(report.provenance_status, 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE');
  assert.ok(report.artifacts.every(receipt => receipt.source_kind === 'trace-derived'));
});
test('declared native bytes do not claim provider authentication', () => {
  const {expected, packet} = fixture({sourceKind: 'native-artifact'});
  const report = generateReview(packet, expected);
  assert.equal(report.provenance_status, 'NATIVE_BYTES_DECLARED');
  assert.match(report.provenance_limit, /does not authenticate/);
});
test('recorded risk acceptance never rewrites native failure or authorizes release', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = {status: 'ACCEPTED', scope: 'contest-only', project: expected.project, sha: expected.sha, pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: ['GHSA-example-synthetic']};
  const report = generateReview(packet, expected);
  assert.equal(report.owner_risk_disposition.status, 'RECORDED_ACCEPTANCE');
  assert.equal(report.owner_risk_disposition.grants_release, false);
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.human_release.approved, false);
  expected.reviewed_at = '2026-11-17T00:00:00Z';
  assert.equal(generateReview(packet, expected).owner_risk_disposition.status, 'EXPIRED');
});
test('forged authority fields in a disposition are rejected', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = {status: 'ACCEPTED', scope: 'contest-only', project: expected.project, sha: expected.sha, pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: ['GHSA-example-synthetic'], approved: true};
  assert.throws(() => generateReview(packet, expected), /unexpected field/);
});
test('untrusted HTML and historical model interpretation render inert', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture();
  packet.model.text = '</div><script>alert(1)</script><img src=x onerror="alert(2)"> & \'quoted\'';
  const html = renderHtml(generateReview(packet, expected));
  assert.ok(!html.includes('<script>') && !html.includes('<img '));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&quot;') && html.includes('&#39;'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.equal(generateReview(packet, expected).model_note.source.input_sha, 'b'.repeat(40));
});
test('CLI writes both outputs for valid evidence and writes nothing on wrong identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'releaseproof-cli-'));
  try {
    const {expected, packet} = fixture();
    const expectedPath = path.join(directory, 'expected.json');
    const packetPath = path.join(directory, 'packet.json');
    writeFileSync(expectedPath, JSON.stringify(expected)); writeFileSync(packetPath, JSON.stringify(packet));
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const output = path.join(directory, 'good');
    const good = spawnSync(process.execPath, [cli, '--expected', expectedPath, '--packet', packetPath, '--out', output], {encoding: 'utf8'});
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(output, 'review.json'), 'utf8')).qc_verdict, 'FAILED_WITH_FINDINGS');
    assert.match(readFileSync(path.join(output, 'review.html'), 'utf8'), /Release review/);
    packet.native.commit.id = 'c'.repeat(40); writeFileSync(packetPath, JSON.stringify(packet));
    const badOutput = path.join(directory, 'bad');
    const bad = spawnSync(process.execPath, [cli, '--expected', expectedPath, '--packet', packetPath, '--out', badOutput], {encoding: 'utf8'});
    assert.equal(bad.status, 2);
    assert.equal(existsSync(badOutput), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

// Invented synthetic receipts only. Exercise every accepted native object boundary,
// including each of the five jobs rather than a representative job alone.
const nativeBoundaries = [
  ['native project', packet => packet.native.project],
  ['native commit', packet => packet.native.commit],
  ['native pipeline', packet => packet.native.pipeline],
  ...fixture().packet.native.jobs.flatMap((job, index) => [
    [job.name + ' job', packet => packet.native.jobs[index]],
    [job.name + ' project', packet => packet.native.jobs[index].project],
    [job.name + ' commit', packet => packet.native.jobs[index].commit],
    [job.name + ' pipeline', packet => packet.native.jobs[index].pipeline],
  ]),
];
const withJobProjects = () => {
  const source = fixture();
  for (const job of source.packet.native.jobs) job.project = {id: source.expected.project};
  return source;
};

for (const [label, select] of nativeBoundaries) {
  test(`native receipts reject nested approval claim at ${label} without rewriting evidence`, () => {
    const {packet, expected} = withJobProjects();
    select(packet).release_approval = {approved: true};
    const before = canonicalJson(packet);
    assert.throws(() => generateReview(packet, expected), /unexpected field/);
    assert.equal(canonicalJson(packet), before);
  });
}

for (const projects of [false, true]) test(`supported native receipt shape with job projects ${projects ? 'present' : 'absent'} retains evidence and limits`, () => {
  const {packet, expected} = projects ? withJobProjects() : fixture();
  // Numeric and string ID forms were already supported; neither is rewritten.
  packet.native.project.id = expected.project;
  packet.native.pipeline.id = expected.pipeline;
  const before = canonicalJson(packet);
  const report = generateReview(packet, expected);
  assert.equal(canonicalJson(packet), before);
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.findings.find(row => row.name === 'dependencies_full').severity_counts.high, 5);
  assert.equal(report.provenance_status, 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE');
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
  for (const job of packet.native.jobs) assert.equal(Object.hasOwn(job, 'project'), projects);
});

for (const [label, mutate] of [
  ['null native project', packet => {packet.native.project = null;}],
  ['array native commit', packet => {packet.native.commit = [];}],
  ['scalar native pipeline', packet => {packet.native.pipeline = 'failed';}],
  ['missing pipeline status', packet => {delete packet.native.pipeline.status;}],
  ['null job project', packet => {packet.native.jobs[0].project = null;}],
  ['array job project', packet => {packet.native.jobs[0].project = [];}],
  ['missing job project ID', packet => {packet.native.jobs[0].project = {};}],
  ['wrong job project ID', packet => {packet.native.jobs[0].project = {id: '99'};}],
  ['invalid job project ID', packet => {packet.native.jobs[0].project = {id: false};}],
  ['null job commit', packet => {packet.native.jobs[0].commit = null;}],
  ['array job pipeline', packet => {packet.native.jobs[0].pipeline = [];}],
  ['missing job pipeline project ID', packet => {delete packet.native.jobs[0].pipeline.project_id;}],
  ['unmodelled raw project metadata', packet => {packet.native.project.web_url = 'https://synthetic.example.invalid/';}],
  ['unmodelled raw job metadata', packet => {packet.native.jobs[0].artifacts = [];}],
]) test(`native receipt shape rejects ${label}`, () => {
  const {packet, expected} = fixture(); mutate(packet);
  assert.throws(() => generateReview(packet, expected), EvidenceError);
});

for (const [label, select] of nativeBoundaries) test(`CLI rejects native approval at ${label} before producing reports`, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'releaseproof-native-authority-'));
  try {
    const {packet, expected} = withJobProjects();
    select(packet).release_approval = {approved: true};
    const expectedPath = path.join(directory, 'expected.json');
    const packetPath = path.join(directory, 'packet.json');
    const expectedBytes = canonicalJson(expected);
    const packetBytes = canonicalJson(packet);
    writeFileSync(expectedPath, expectedBytes); writeFileSync(packetPath, packetBytes);
    const output = path.join(directory, 'fresh-output');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)),
      '--expected', expectedPath, '--packet', packetPath, '--out', output], {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unexpected field/);
    assert.equal(existsSync(output), false);
    assert.equal(readFileSync(expectedPath, 'utf8'), expectedBytes);
    assert.equal(readFileSync(packetPath, 'utf8'), packetBytes);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
