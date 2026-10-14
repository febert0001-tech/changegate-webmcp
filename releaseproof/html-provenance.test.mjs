import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';
import {generateReview, renderHtml, escapeHtml} from './report.mjs';

const endings = [
  ['CR', 'a\rb', 'a&#13;b'],
  ['LF', 'a\nb', 'a\nb'],
  ['CRLF', 'a\r\nb', 'a&#13;\nb'],
];
for (const [name, value, escaped] of endings) {
  test('HTML escaping preserves ' + name + ' evidence distinctly', () => {
    assert.equal(escapeHtml(value), escaped);
  });
}
test('CR, LF and CRLF remain distinct through HTML input-stream preprocessing', () => {
  // HTML input preprocessing normalizes literal CR/CRLF before tokenization.
  // Character references are resolved later, so these wire forms stay distinct.
  const preprocess = value => value.replace(/\r\n?/g, '\n');
  const escaped = endings.map(([, value]) => preprocess(escapeHtml(value)));
  assert.deepEqual(escaped, endings.map(([, , expected]) => expected));
  assert.equal(new Set(escaped).size, 3);
});
test('literal carriage-return reference text is escaped rather than reinterpreted', () => {
  assert.equal(escapeHtml('a&#13;b'), 'a&amp;#13;b');
  assert.notEqual(escapeHtml('a&#13;b'), escapeHtml('a\rb'));
});
test('carriage-return escaping preserves valid Unicode and existing HTML escaping', () => {
  assert.equal(escapeHtml('標本-é-e\u0301-🚀\r<&"\''), '標本-é-e\u0301-🚀&#13;&lt;&amp;&quot;&#39;');
});

const risk = (expected, advisories) => ({status: 'ACCEPTED', scope: 'contest-only', project: expected.project,
  sha: expected.sha, pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: advisories});
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
};
function contextReport(kind, value) {
  const source = fixture();
  if (kind === 'model') { source.packet.model = modelFixture(); source.packet.model.text = value; }
  else {
    replaceSummary(source.packet, summary => {
      const findings = summary.results.dependencies_full.findings;
      if (kind === 'records') findings.records[0] = value;
      else findings.advisory_ids = [value];
    });
    if (kind === 'risk') source.expected.owner_disposition = risk(source.expected, [value]);
  }
  return generateReview(source.packet, source.expected);
}
function contextText(html, kind) {
  if (kind === 'model') {
    const match = html.match(/<div class="note">([\s\S]*?)<\/div>/);
    assert.ok(match);
    return match[1];
  }
  let markup;
  if (kind === 'risk') {
    const match = html.match(/<dt>Accepted advisory IDs<\/dt><dd>([\s\S]*?)<\/dd>/);
    assert.ok(match); markup = match[1];
  } else {
    const row = html.match(/<tr><td>dependencies_full<\/td>[\s\S]*?<\/tr>/);
    assert.ok(row);
    const cells = Array.from(row[0].matchAll(/<td>([\s\S]*?)<\/td>/g), match => match[1]);
    markup = cells[kind === 'records' ? 5 : 6];
  }
  const item = markup.match(/<li><code class="evidence-text">([\s\S]*?)<\/code><\/li>/);
  assert.ok(item);
  return item[1];
}
for (const kind of ['records', 'advisory', 'risk', 'model']) {
  test('rendered ' + kind + ' distinguishes CR, LF and CRLF without rewriting evidence', () => {
    const texts = [];
    for (const [, value, expected] of endings) {
      const report = contextReport(kind, value);
      const html = renderHtml(report);
      assert.ok(!html.includes('\r'), 'HTML must not contain literal carriage returns');
      const actual = contextText(html, kind);
      assert.equal(actual, expected);
      texts.push(actual);
      if (kind === 'model') assert.equal(report.model_note.text, value);
      else if (kind === 'risk') assert.deepEqual(report.owner_risk_disposition.advisory_ids, [value]);
      else {
        const row = report.findings.find(row => row.name === 'dependencies_full');
        assert.equal(kind === 'records' ? row.records[0] : row.advisory_ids[0], value);
      }
      retained(report);
    }
    assert.equal(new Set(texts).size, 3);
  });
}

for (const [name, value] of endings) {
  test('CLI preserves original ' + name + ' in JSON and character-reference distinctions in HTML', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-cr-html-'));
    try {
      const source = fixture();
      const record = 'pkg-' + value;
      const advisory = 'GHSA-synthetic-' + value;
      replaceSummary(source.packet, summary => {
        summary.results.dependencies_full.findings.records[0] = record;
        summary.results.dependencies_full.findings.advisory_ids = [advisory];
      });
      source.expected.owner_disposition = risk(source.expected, [advisory]);
      source.packet.model = modelFixture(); source.packet.model.text = value;
      const expectedPath = path.join(directory, 'expected.json');
      const packetPath = path.join(directory, 'packet.json');
      const original = [Buffer.from(JSON.stringify(source.expected)), Buffer.from(JSON.stringify(source.packet))];
      fs.writeFileSync(expectedPath, original[0]); fs.writeFileSync(packetPath, original[1]);
      const output = path.join(directory, 'output');
      const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [cli, '--expected', expectedPath, '--packet', packetPath, '--out', output],
        {encoding: 'utf8', timeout: 10_000});
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(expectedPath), original[0]);
      assert.deepEqual(fs.readFileSync(packetPath), original[1]);
      const report = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'));
      assert.equal(report.findings.find(row => row.name === 'dependencies_full').records[0], record);
      assert.deepEqual(report.owner_risk_disposition.advisory_ids, [advisory]);
      assert.equal(report.model_note.text, value);
      const html = fs.readFileSync(path.join(output, 'review.html'), 'utf8');
      assert.ok(!html.includes('\r'));
      assert.equal(contextText(html, 'records'), escapeHtml(record));
      assert.equal(contextText(html, 'advisory'), escapeHtml(advisory));
      assert.equal(contextText(html, 'risk'), escapeHtml(advisory));
      assert.equal(contextText(html, 'model'), escapeHtml(value));
      retained(report);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  });
}

const modelSection = html => {
  const section = html.split('<h2>Historical model interpretation</h2>')[1];
  assert.ok(section);
  return section.split('<h2>Receipt and byte-integrity details</h2>')[0];
};
test('HTML displays the historical model input commit separately from the reviewed commit', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture();
  const report = generateReview(packet, expected);
  const input = packet.model.source.input_sha;
  assert.notEqual(input, expected.sha);
  const html = renderHtml(report);
  assert.ok(html.includes('Reviewed commit <code>' + expected.sha + '</code>'));
  const section = modelSection(html);
  assert.ok(section.includes('Historical model input commit: <code>' + input + '</code>'));
  assert.ok(!section.includes(expected.sha));
  assert.equal(report.model_note.source.input_sha, input);
  retained(report);
});
test('HTML explicitly states Not supplied when historical model input_sha is absent', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture(); delete packet.model.source.input_sha;
  const report = generateReview(packet, expected);
  assert.equal(report.model_note.source.input_sha, null);
  const html = renderHtml(report);
  assert.ok(html.includes('Reviewed commit <code>' + expected.sha + '</code>'));
  const section = modelSection(html);
  assert.ok(section.includes('Historical model input commit: <code>Not supplied</code>'));
  assert.ok(!section.includes(expected.sha));
});
test('matching model and reviewed SHAs remain separately labelled provenance roles', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture(); packet.model.source.input_sha = expected.sha;
  const html = renderHtml(generateReview(packet, expected));
  assert.ok(html.includes('Reviewed commit <code>' + expected.sha + '</code>'));
  assert.ok(modelSection(html).includes('Historical model input commit: <code>' + expected.sha + '</code>'));
});
test('absent model note does not invent historical model provenance', () => {
  const {expected, packet} = fixture();
  const report = generateReview(packet, expected);
  assert.equal(report.model_note, null);
  const html = renderHtml(report);
  assert.ok(!html.includes('Historical model interpretation') && !html.includes('Historical model input commit'));
});
test('historical model input commit text is escaped by the renderer', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture();
  const report = generateReview(packet, expected);
  // Renderer defense only; non-hex input SHA evidence still fails generation.
  report.model_note.source.input_sha = '"><script>synthetic & \'commit\'</script>';
  const section = modelSection(renderHtml(report));
  assert.ok(!section.includes('<script>'));
  assert.ok(section.includes('&quot;&gt;&lt;script&gt;synthetic &amp; &#39;commit&#39;&lt;/script&gt;'));
});
