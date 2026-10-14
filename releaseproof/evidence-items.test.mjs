import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';
import {parseJson, generateReview, renderHtml, canonicalJson, escapeHtml, digest} from './report.mjs';

const risk = (expected, advisories) => ({status: 'ACCEPTED', scope: 'contest-only', project: expected.project,
  sha: expected.sha, pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: advisories});
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
};
const rowHtml = (html, name) => {
  const match = html.match(new RegExp('<tr><td>' + name + '</td>[\\s\\S]*?</tr>'));
  assert.ok(match);
  return match[0];
};
const cell = (html, name, index) => Array.from(rowHtml(html, name).matchAll(/<td>([\s\S]*?)<\/td>/g), match => match[1])[index];
const listItems = markup => Array.from(markup.matchAll(/<li><code class="evidence-text">([\s\S]*?)<\/code><\/li>/g), match => match[1]);

for (const [name, data] of [
  ['value', {record: 'pkg\u0000name'}],
  ['nested value', {rows: [{record: 'pkg\u0000name'}]}],
  ['key', {'pkg\u0000name': 'synthetic'}],
  ['nested key', {rows: [{'pkg\u0000name': 'synthetic'}]}],
]) {
  test('post-parse validation rejects U+0000 in ' + name, () => {
    assert.throws(() => parseJson(JSON.stringify(data), 'synthetic'), /synthetic: null character/);
  });
}
for (const field of ['records', 'advisory_ids']) {
  test('raw artifact rejects U+0000 in dependency ' + field, () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => { summary.results.dependencies_full.findings[field][0] = 'synthetic\u0000entry'; });
    assert.throws(() => generateReview(packet, expected), /artifact: null character/);
  });
}
test('raw validation artifact rejects a nested U+0000 key before exact-key validation', () => {
  const {expected, packet} = fixture();
  packet.validation_exits_raw = JSON.stringify({assessor: 0, tests: 0, typecheck: 0, lint: 0, build: 0, extra: {'synthetic\u0000key': 0}});
  packet.provenance.validation_exits.sha256 = digest(packet.validation_exits_raw);
  packet.provenance.validation_exits.byte_count = Buffer.byteLength(packet.validation_exits_raw);
  assert.throws(() => generateReview(packet, expected), /artifact: null character/);
});
test('object report caller rejects U+0000 in model text', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture(); packet.model.text = 'historical\u0000text';
  assert.throws(() => generateReview(packet, expected), /packet: null character/);
});
test('object report caller rejects an otherwise unused nested U+0000 key', () => {
  const {expected, packet} = fixture();
  packet.native.project.extra = {rows: [{'synthetic\u0000key': 'metadata'}]};
  assert.throws(() => generateReview(packet, expected), /packet: null character/);
});
for (const kind of ['value', 'key']) {
  test('renderer rejects U+0000 in direct output ' + kind, () => {
    const {expected, packet} = fixture();
    const report = generateReview(packet, expected);
    if (kind === 'value') report.findings.find(row => row.name === 'dependencies_full').records[0] = 'pkg\u0000name';
    else report.extra = {'synthetic\u0000key': 'metadata'};
    assert.throws(() => renderHtml(report), /review output: null character/);
  });
}

function cliCase(source, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-evidence-items-'));
  try {
    const inputs = {expected: path.join(directory, 'expected.json'), packet: path.join(directory, 'packet.json')};
    const bytes = {expected: Buffer.from(JSON.stringify(source.expected)), packet: Buffer.from(JSON.stringify(source.packet))};
    for (const key of ['expected', 'packet']) fs.writeFileSync(inputs[key], bytes[key]);
    const output = path.join(directory, 'output');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', inputs.expected, '--packet', inputs.packet, '--out', output],
      {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    for (const key of ['expected', 'packet']) assert.deepEqual(fs.readFileSync(inputs[key]), bytes[key]);
    check({result, output});
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
for (const key of ['expected', 'packet']) {
  test('CLI rejects U+0000 in ' + key + ' without creating output', () => {
    const source = fixture();
    if (key === 'expected') {
      const advisory = 'synthetic\u0000advisory';
      replaceSummary(source.packet, summary => { summary.results.dependencies_full.findings.advisory_ids = [advisory]; });
      source.expected.owner_disposition = risk(source.expected, [advisory]);
    } else { source.packet.model = modelFixture(); source.packet.model.text = 'historical\u0000text'; }
    cliCase(source, ({result, output}) => {
      assert.equal(result.status, 2);
      assert.equal(result.stderr, (key === 'expected' ? 'expectation' : 'packet') + ': null character\n');
      assert.equal(fs.existsSync(output), false);
    });
  });
}
test('valid Unicode remains exact in normalized JSON and escaped HTML list items', () => {
  const source = fixture();
  const record = ' pkg-標本-é-e\u0301-🚀-\ufffd ';
  const advisory = 'GHSA-標本-🚀-\ufffd';
  replaceSummary(source.packet, summary => {
    summary.results.dependencies_full.findings.records[0] = record;
    summary.results.dependencies_full.findings.advisory_ids = [advisory];
  });
  source.expected.owner_disposition = risk(source.expected, [advisory]);
  cliCase(source, ({result, output}) => {
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
    assert.equal(report.findings.find(row => row.name === 'dependencies_full').records[0], record);
    assert.deepEqual(report.owner_risk_disposition.advisory_ids, [advisory]);
    const html = fs.readFileSync(path.join(output, 'review.html'), 'utf8');
    assert.equal(listItems(cell(html, 'dependencies_full', 5))[0], record);
    assert.deepEqual(listItems(cell(html, 'dependencies_full', 6)), [advisory]);
    retained(report);
  });
});

function evidenceReport(kind, values) {
  const {expected, packet} = fixture();
  replaceSummary(packet, summary => {
    const full = summary.results.dependencies_full;
    if (kind === 'records') {
      full.findings.records = values;
      full.findings.count = values.length;
      full.findings.severity_counts.high = values.length;
      full.findings.severity_counts.total = values.length;
    } else if (kind === 'scan') {
      summary.results.sast.findings.ids = values;
      summary.results.sast.findings.count = values.length;
    } else full.findings.advisory_ids = values;
  });
  if (kind === 'risk') expected.owner_disposition = risk(expected, values);
  return generateReview(packet, expected);
}
function evidenceMarkup(report, kind) {
  const html = renderHtml(report);
  if (kind === 'risk') {
    const match = html.match(/<dt>Accepted advisory IDs<\/dt><dd>([\s\S]*?)<\/dd>/);
    assert.ok(match);
    return match[1];
  }
  return cell(html, kind === 'scan' ? 'sast' : 'dependencies_full', kind === 'records' ? 5 : 6);
}
for (const kind of ['records', 'advisory', 'risk', 'scan']) {
  test('HTML preserves one comma-bearing ' + kind + ' item versus two separate items', () => {
    const single = ['synthetic-a, synthetic-b'];
    const separate = ['synthetic-a', 'synthetic-b'];
    const oneReport = evidenceReport(kind, single);
    const twoReport = evidenceReport(kind, separate);
    const oneMarkup = evidenceMarkup(oneReport, kind);
    const twoMarkup = evidenceMarkup(twoReport, kind);
    assert.deepEqual(listItems(oneMarkup), single);
    assert.deepEqual(listItems(twoMarkup), separate);
    assert.notEqual(oneMarkup, twoMarkup);
    retained(oneReport); retained(twoReport);
  });
}
for (const kind of ['records', 'advisory', 'risk']) {
  test('HTML escapes each ' + kind + ' item and preserves internal commas and line breaks', () => {
    const values = ['<script>synthetic</script> & \'quoted\'', 'value, with comma\nand next line', '</code></li><li>forged'];
    const report = evidenceReport(kind, values);
    const markup = evidenceMarkup(report, kind);
    assert.deepEqual(listItems(markup), values.map(escapeHtml));
    assert.ok(!markup.includes('<script>') && !markup.includes('<li>forged'));
    assert.ok(renderHtml(report).includes('.evidence-text{white-space:pre-wrap;'));
    retained(report);
  });
}
test('empty evidence lists remain explicitly empty rather than inventing items', () => {
  const {expected, packet} = fixture({findings: false});
  const html = renderHtml(generateReview(packet, expected));
  for (const index of [5, 6]) {
    const markup = cell(html, 'dependencies_full', index);
    assert.ok(markup.includes('None reported'));
    assert.deepEqual(listItems(markup), []);
  }
});

const names = ['sast', 'secrets', 'dependencies_full', 'dependencies_production'];
function nonemptyRows(summary) {
  for (const name of ['sast', 'secrets']) {
    summary.results[name].findings.count = 2;
    summary.results[name].findings.ids = ['synthetic-scan-1', 'synthetic-scan-2'];
  }
  const production = summary.results.dependencies_production;
  production.findings = structuredClone(summary.results.dependencies_full.findings);
  production.findings.records = production.findings.records.slice(0, 2);
  production.findings.count = 2;
  production.findings.severity_counts.high = 2;
  production.findings.severity_counts.total = 2;
  production.command_exit = 1;
}
for (const name of names) {
  const count = name === 'dependencies_full' ? 5 : 2;
  for (const [description, target] of [['absent', undefined], ['zero', 0], ['partial', 1], ['all', count]]) {
    test('normalized JSON and HTML preserve ' + description + ' target_count for ' + name, () => {
      const {expected, packet} = fixture();
      replaceSummary(packet, summary => {
        nonemptyRows(summary);
        if (target !== undefined) summary.results[name].findings.target_count = target;
      });
      const report = generateReview(packet, expected);
      const row = JSON.parse(canonicalJson(report)).findings.find(value => value.name === name);
      assert.equal(Object.hasOwn(row, 'target_count'), target !== undefined);
      if (target !== undefined) assert.equal(row.target_count, target);
      assert.equal(cell(renderHtml(report), name, 4), target === undefined ? 'Not supplied' : String(target));
      retained(report);
    });
  }
}
for (const invalid of [-1, null, '0', 1.5, 6]) {
  test('target_count retains integer and bounds validation for ' + JSON.stringify(invalid), () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => { summary.results.dependencies_full.findings.target_count = invalid; });
    assert.throws(() => generateReview(packet, expected), /target findings disagree/);
  });
}
for (const name of names) {
  test('rejects target_count exceeding finding count for ' + name, () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => {
      nonemptyRows(summary);
      const findings = summary.results[name].findings;
      findings.target_count = findings.count + 1;
    });
    assert.throws(() => generateReview(packet, expected), /target findings disagree/);
  });
}
test('zero target_count remains supplied on zero-finding rows', () => {
  const {expected, packet} = fixture({findings: false});
  replaceSummary(packet, summary => { for (const name of names) summary.results[name].findings.target_count = 0; });
  const report = generateReview(packet, expected);
  for (const name of names) {
    const row = report.findings.find(value => value.name === name);
    assert.equal(row.target_count, 0);
    assert.equal(cell(renderHtml(report), name, 4), '0');
  }
});
test('CLI persists supplied zero target_count in both report files', () => {
  const source = fixture();
  replaceSummary(source.packet, summary => { summary.results.dependencies_full.findings.target_count = 0; });
  cliCase(source, ({result, output}) => {
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
    assert.equal(report.findings.find(row => row.name === 'dependencies_full').target_count, 0);
    const html = fs.readFileSync(path.join(output, 'review.html'), 'utf8');
    assert.equal(cell(html, 'dependencies_full', 4), '0');
    retained(report);
  });
});
