import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';
import {parseJson, generateReview, renderHtml} from './report.mjs';

const malformed = [
  ['lone high surrogate', '\ud800'],
  ['last high surrogate', '\udbff'],
  ['lone low surrogate', '\udc00'],
  ['last low surrogate', '\udfff'],
  ['reversed pair', '\udc00\ud800'],
  ['interrupted pair', '\ud800x'],
];
const shapes = [
  ['string value', value => ({record: value})],
  ['nested string value', value => ({rows: [{nested: {record: value}}]})],
  ['object key', value => ({[value]: 'synthetic record'})],
  ['nested object key', value => ({rows: [{nested: {[value]: 'synthetic record'}}]})],
];
for (const [name, value] of malformed) {
  for (const [shape, create] of shapes) {
    test('post-parse validation rejects ' + name + ' in ' + shape, () => {
      const raw = JSON.stringify(create(value));
      assert.throws(() => parseJson(raw, 'synthetic'), /synthetic: unpaired Unicode surrogate/);
    });
  }
}

const risk = (expected, advisory) => ({
  status: 'ACCEPTED', scope: 'contest-only', project: expected.project, sha: expected.sha,
  pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: [advisory],
});
function cliCase(source, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-surrogates-'));
  try {
    const files = {expected: path.join(directory, 'expected.json'), packet: path.join(directory, 'packet.json')};
    const bytes = {expected: Buffer.from(JSON.stringify(source.expected)), packet: Buffer.from(JSON.stringify(source.packet))};
    fs.writeFileSync(files.expected, bytes.expected);
    fs.writeFileSync(files.packet, bytes.packet);
    const output = path.join(directory, 'output');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', files.expected, '--packet', files.packet, '--out', output],
      {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    for (const key of ['expected', 'packet']) assert.deepEqual(fs.readFileSync(files[key]), bytes[key], 'source evidence must not be rewritten');
    check({result, output});
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
for (const [name, value] of [malformed[0], malformed[2]]) {
  for (const key of ['expected', 'packet']) {
    test('CLI rejects JSON-escaped ' + name + ' in ' + key, () => {
      const source = fixture();
      if (key === 'expected') {
        replaceSummary(source.packet, summary => { summary.results.dependencies_full.findings.advisory_ids = [value]; });
        source.expected.owner_disposition = risk(source.expected, value);
      } else {
        source.packet.model = modelFixture();
        source.packet.model.text = value;
      }
      cliCase(source, ({result, output}) => {
        assert.equal(result.status, 2);
        assert.equal(result.stderr, (key === 'expected' ? 'expectation' : 'packet') + ': unpaired Unicode surrogate\n');
        assert.equal(result.stdout, '');
        assert.equal(fs.existsSync(output), false);
      });
    });
  }
  test('CLI rejects JSON-escaped ' + name + ' in a nested metadata key', () => {
    const source = fixture();
    source.packet.native.project.extra = {items: [{[value]: 'synthetic metadata'}]};
    cliCase(source, ({result, output}) => {
      assert.equal(result.status, 2);
      assert.equal(result.stderr, 'packet: unpaired Unicode surrogate\n');
      assert.equal(fs.existsSync(output), false);
    });
  });
  for (const field of ['records', 'advisory_ids']) {
    test('raw summary rejects ' + name + ' in dependency ' + field + ' with recomputed digest', () => {
      const {expected, packet} = fixture();
      replaceSummary(packet, summary => { summary.results.dependencies_full.findings[field][0] = value; });
      assert.throws(() => generateReview(packet, expected), /artifact: unpaired Unicode surrogate/);
    });
  }
  test('object report caller rejects ' + name + ' in model text', () => {
    const {expected, packet} = fixture();
    packet.model = modelFixture();
    packet.model.text = value;
    assert.throws(() => generateReview(packet, expected), /packet: unpaired Unicode surrogate/);
  });
  test('object report caller rejects ' + name + ' in an otherwise unused nested key', () => {
    const {expected, packet} = fixture();
    packet.native.project.extra = {items: [{[value]: 'synthetic metadata'}]};
    assert.throws(() => generateReview(packet, expected), /packet: unpaired Unicode surrogate/);
  });
}

test('valid escaped surrogate pairs remain intact in values and keys', () => {
  const raw = '{"value":"\\ud83d\\ude80","\\ud83d\\ude80":"synthetic"}';
  assert.deepEqual(parseJson(raw, 'synthetic'), {value: '🚀', '🚀': 'synthetic'});
});
test('valid literal Unicode values and keys are preserved without normalization', () => {
  const value = '標本-é-e\u0301-\ufffd-🚀';
  const original = {[value]: {value}};
  assert.deepEqual(parseJson(JSON.stringify(original), 'synthetic'), original);
});
test('minimum and maximum valid surrogate pairs remain intact', () => {
  const value = '\ud800\udc00-\udbff\udfff';
  const original = {[value]: value};
  assert.deepEqual(parseJson(JSON.stringify(original), 'synthetic'), original);
});
test('literal backslash-u text is not interpreted or rewritten as a surrogate', () => {
  const original = {record: '\\ud800', '\\udc00': 'synthetic'};
  assert.deepEqual(parseJson(JSON.stringify(original), 'synthetic'), original);
});

for (const [name, value] of [
  ['minimum valid pair', '\ud800\udc00'],
  ['maximum valid pair', '\udbff\udfff'],
  ['literal mixed Unicode', '標本-é-e\u0301-🚀-\ufffd'],
]) {
  test('CLI JSON and HTML preserve ' + name + ' evidence exactly', () => {
    const source = fixture();
    const record = ' \tsynthetic-record-' + value + ' ';
    const advisory = 'GHSA-synthetic-' + value;
    replaceSummary(source.packet, summary => {
      summary.results.dependencies_full.findings.records[0] = record;
      summary.results.dependencies_full.findings.advisory_ids = [advisory];
    });
    source.expected.owner_disposition = risk(source.expected, advisory);
    source.packet.model = modelFixture();
    source.packet.model.text = value;
    cliCase(source, ({result, output}) => {
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
      assert.equal(report.findings.find(row => row.name === 'dependencies_full').records[0], record);
      assert.deepEqual(report.owner_risk_disposition.advisory_ids, [advisory]);
      assert.equal(report.model_note.text, value);
      const html = fs.readFileSync(path.join(output, 'review.html'), 'utf8');
      assert.ok(html.includes(record));
      assert.ok(html.includes(advisory));
      assert.equal(html, renderHtml(generateReview(source.packet, source.expected)));
      assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
      assert.equal(report.human_release.status, 'PENDING');
      assert.equal(report.human_release.approved, false);
    });
  });
}
