import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAudit} from './dependency-audit.mjs';

// Synthetic unit inputs only; never presented as registry audit evidence.
const result = (count = 0) => ({status: count ? 1 : 0, signal: null,
  stdout: Buffer.from(JSON.stringify({auditReportVersion: 2,
    vulnerabilities: count ? {synthetic: {name: 'synthetic', severity: 'high', via: []}} : {},
    metadata: {vulnerabilities: {info: 0, low: 0, moderate: 0, high: count, critical: 0, total: count}}}))});
for (const count of [0, 1]) test(`classifies completed synthetic audit with ${count} finding`, () => {
  assert.equal(classifyAudit(result(count)).outcome, count ? 'COMPLETED_WITH_FINDINGS' : 'COMPLETED_NO_FINDINGS');
});
for (const [name, mutate] of [
  ['spawn failure', value => {value.error = {code: 'ENOENT'};}],
  ['signal', value => {value.signal = 'SIGTERM';}],
  ['unexpected exit', value => {value.status = 2;}],
]) test(`does not accept ${name} as completed audit`, () => {
  const value = result(1); mutate(value);
  assert.equal(classifyAudit(value).outcome, 'COMMAND_FAILURE');
});
for (const [name, mutate] of [
  ['invalid JSON', value => {value.stdout = Buffer.from('{');}],
  ['registry error JSON with exit 1', value => {value.stdout = Buffer.from('{"error":{"code":"E503"}}');}],
  ['findings with exit 0', value => {value.status = 0;}],
  ['wrong vulnerability counts', value => {const data = JSON.parse(value.stdout); data.metadata.vulnerabilities.total = 0; value.stdout = Buffer.from(JSON.stringify(data));}],
]) test(`does not accept ${name} as completed evidence`, () => {
  const value = result(1); mutate(value);
  assert.equal(classifyAudit(value).outcome, 'MALFORMED_EVIDENCE');
});

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const single = (entrySeverity, metadataSeverity) => ({status: 1, signal: null,
  stdout: Buffer.from(JSON.stringify({auditReportVersion: 2,
    vulnerabilities: {synthetic: {name: 'synthetic', severity: entrySeverity, via: []}},
    metadata: {vulnerabilities: {...Object.fromEntries(severities.map(key => [key, key === metadataSeverity ? 1 : 0])), total: 1}}}))});
for (const [index, severity] of severities.entries()) {
  test(`reconciles valid entry and metadata bucket ${severity}`, () => {
    const value = single(severity, severity);
    const bytes = Buffer.from(value.stdout);
    const classified = classifyAudit(value);
    assert.equal(classified.outcome, 'COMPLETED_WITH_FINDINGS');
    assert.equal(classified.counts[severity], 1);
    assert.deepEqual(value.stdout, bytes);
  });
  test(`rejects metadata ${severity} when the sole entry has a different severity`, () => {
    const value = single(severities[(index + 1) % severities.length], severity);
    const bytes = Buffer.from(value.stdout);
    assert.deepEqual(classifyAudit(value), {outcome: 'MALFORMED_EVIDENCE'});
    assert.deepEqual(value.stdout, bytes, 'raw inconsistent evidence remains intact');
  });
}
for (const severity of [undefined, null, false, 7, [], {}, 'CRITICAL', 'unknown']) test(`rejects malformed entry severity ${JSON.stringify(severity)}`, () => {
  const value = single(severity, 'high');
  const bytes = Buffer.from(value.stdout);
  assert.deepEqual(classifyAudit(value), {outcome: 'MALFORMED_EVIDENCE'});
  assert.deepEqual(value.stdout, bytes);
});
test('tallies multiple entries across all buckets without changing raw bytes', () => {
  const report = {auditReportVersion: 2, vulnerabilities: Object.fromEntries(severities.map(severity =>
    [severity, {name: severity, severity, via: []}])),
  metadata: {vulnerabilities: {...Object.fromEntries(severities.map(key => [key, 1])), total: severities.length}}};
  const value = {status: 1, signal: null, stdout: Buffer.from(JSON.stringify(report))};
  const bytes = Buffer.from(value.stdout);
  assert.equal(classifyAudit(value).outcome, 'COMPLETED_WITH_FINDINGS');
  assert.deepEqual(value.stdout, bytes);
  report.vulnerabilities.high.severity = 'critical'; // Same entry count and aggregate total; different buckets.
  value.stdout = Buffer.from(JSON.stringify(report));
  const inconsistentBytes = Buffer.from(value.stdout);
  assert.deepEqual(classifyAudit(value), {outcome: 'MALFORMED_EVIDENCE'});
  assert.deepEqual(value.stdout, inconsistentBytes);
});

for (const [label, change] of [
  ['literal entry severity', raw => raw.replace('"severity":"high"', '"severity":"critical","severity":"high"')],
  ['escaped-equivalent entry severity', raw => raw.replace('"severity":"high"', String.raw`"severity":"critical","severit\u0079":"high"`)],
  ['vulnerability package member', raw => raw.replace('"vulnerabilities":{"synthetic":', '"vulnerabilities":{"synthetic":{"name":"synthetic","severity":"critical","via":[]},"synthetic":')],
  ['metadata severity bucket', raw => raw.replace('"critical":0', '"critical":1,"critical":0')],
  ['nested dependency metadata', raw => raw.replace('"metadata":{', '"metadata":{"dependencies":{"prod":99,"prod":1},')],
  ['escaped-equivalent member in nested advisory array', raw => raw.replace('"via":[]', String.raw`"via":[{"source":1,"severity":"critical","severit\u0079":"high"}]`)],
  ['top-level audit version', raw => raw.replace('"auditReportVersion":2', '"auditReportVersion":1,"auditReportVersion":2')],
  ['top-level vulnerabilities object', raw => raw.replace('"vulnerabilities":{', '"vulnerabilities":{"hidden":{"name":"hidden","severity":"critical","via":[]}},"vulnerabilities":{')],
]) test(`native audit rejects duplicate ${label} before reconciliation without rewriting raw bytes`, () => {
  const value = result(1);
  value.stdout = Buffer.from(change(value.stdout.toString('utf8')));
  // Ordinary parsing would erase the conflicting member and let these fixtures
  // pass the existing shape and severity checks; strict parsing must reject them.
  assert.doesNotThrow(() => JSON.parse(value.stdout.toString('utf8')));
  const bytes = Buffer.from(value.stdout);
  assert.deepEqual(classifyAudit(value), {outcome: 'MALFORMED_EVIDENCE'});
  assert.deepEqual(value.stdout, bytes);
});

test('native audit allows repeated names in separate objects and JSON-looking evidence text', () => {
  const value = result(1);
  const report = JSON.parse(value.stdout);
  report.vulnerabilities.synthetic.via = [{name: 'synthetic', severity: 'high',
    title: 'Literal text: "severity":"critical","severity":"high"'}];
  report.metadata.dependencies = {prod: 1, dev: 0};
  value.stdout = Buffer.from(JSON.stringify(report));
  const bytes = Buffer.from(value.stdout);
  assert.equal(classifyAudit(value).outcome, 'COMPLETED_WITH_FINDINGS');
  assert.deepEqual(value.stdout, bytes);
});
