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
