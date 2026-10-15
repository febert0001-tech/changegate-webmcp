import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateReview, renderHtml, parseJson, digest, JOB_NAMES} from './report.mjs';
import {fixture, replaceSummary, modelFixture} from './fixtures.mjs';

const risk = expected => ({status: 'ACCEPTED', scope: 'contest-only', project: expected.project, sha: expected.sha,
  pipeline: expected.pipeline, expires_at: '2026-11-16T23:59:59Z', advisory_ids: ['GHSA-example-synthetic']});
const retained = report => {
  assert.equal(report.qc_verdict, 'FAILED_WITH_FINDINGS');
  assert.equal(report.native_pipeline_status, 'failed');
  assert.equal(report.human_release.approved, false);
  assert.equal(report.human_release.status, 'PENDING');
  assert.equal(report.deployment.authorized, false);
  assert.ok(report.historical_unknowns.includes('diagnostic_artifact_capture_time'));
  assert.ok(report.historical_unknowns.includes('lifecycle_approval_configuration_comparison'));
};
const rawArtifact = (packet, key, raw) => {
  packet[key + '_raw'] = raw;
  packet.provenance[key].sha256 = digest(raw);
  packet.provenance[key].byte_count = Buffer.byteLength(raw, 'utf8');
};
const productionSubset = summary => {
  const full = summary.results.dependencies_full;
  const production = summary.results.dependencies_production;
  production.findings = structuredClone(full.findings);
  production.findings.records = full.findings.records.slice(0, 2);
  production.findings.count = 2;
  production.findings.severity_counts.high = 2;
  production.findings.severity_counts.total = 2;
  production.command_exit = 1;
};

for (const name of JOB_NAMES) {
  test('rejects contradictory embedded pipeline status in ' + name, () => {
    const {expected, packet} = fixture();
    packet.native.jobs.find(job => job.name === name).pipeline.status = 'success';
    assert.throws(() => generateReview(packet, expected), /pipeline status contradicts/);
  });
}

const authorityTargets = [
  ['summary', summary => summary],
  ['results', summary => summary.results],
];
for (const name of ['sast', 'secrets', 'dependencies_full', 'dependencies_production']) {
  authorityTargets.push([name, summary => summary.results[name]]);
  for (const field of ['execution', 'coverage', 'findings']) {
    authorityTargets.push([name + '.' + field, summary => summary.results[name][field]]);
  }
  if (name.startsWith('dependencies_')) {
    authorityTargets.push([name + '.severity_counts', summary => summary.results[name].findings.severity_counts]);
    authorityTargets.push([name + '.snapshot', summary => summary.results[name].snapshot]);
  }
}
for (const [name, select] of authorityTargets) {
  test('rejects unexpected authority fields at ' + name, () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => { select(summary).release_approval = {approved: true}; });
    assert.throws(() => generateReview(packet, expected), /unexpected field/);
  });
}

test('legacy human decision is retained without inventing a pipeline binding', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = risk(expected);
  delete expected.owner_disposition.pipeline;
  const original = structuredClone(expected.owner_disposition);
  const report = generateReview(packet, expected);
  const decision = report.owner_risk_disposition;
  assert.equal(decision.status, 'UNBOUND_PIPELINE');
  assert.equal(decision.supplied_status, original.status);
  assert.equal(decision.pipeline, null);
  for (const field of ['scope', 'project', 'sha', 'expires_at', 'advisory_ids']) assert.deepEqual(decision[field], original[field]);
  assert.deepEqual(expected.owner_disposition, original);
  assert.equal(decision.grants_release, false);
  assert.match(renderHtml(report), /Not supplied; decision is not attributed to this pipeline/);
  retained(report);
});
test('rejects a risk acceptance explicitly bound to another pipeline of the same commit', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = {...risk(expected), pipeline: '78'};
  assert.throws(() => generateReview(packet, expected), /disposition pipeline mismatch/);
});
test('rejects invalid supplied risk pipeline identity', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = {...risk(expected), pipeline: null};
  assert.throws(() => generateReview(packet, expected), /invalid ID/);
});
test('HTML shows partial acceptance bounds and expiry without changing the verdict', () => {
  const {expected, packet} = fixture();
  replaceSummary(packet, summary => { summary.results.dependencies_full.findings.advisory_ids.push('GHSA-other-synthetic'); });
  expected.owner_disposition = risk(expected);
  const report = generateReview(packet, expected);
  const section = renderHtml(report).split('<h2>Risk disposition</h2>')[1].split('<h2>Historical unknowns</h2>')[0];
  for (const value of ['RECORDED_ACCEPTANCE', 'contest-only', expected.pipeline, expected.owner_disposition.expires_at, 'GHSA-example-synthetic']) assert.ok(section.includes(value));
  assert.ok(!section.includes('GHSA-other-synthetic'));
  retained(report);
});
test('risk advisory IDs remain escaped in HTML', () => {
  const {expected, packet} = fixture();
  const advisory = '<script>synthetic & "advisory"</script>';
  replaceSummary(packet, summary => { summary.results.dependencies_full.findings.advisory_ids = [advisory]; });
  expected.owner_disposition = {...risk(expected), advisory_ids: [advisory]};
  const html = renderHtml(generateReview(packet, expected));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;synthetic &amp; &quot;advisory&quot;&lt;\/script&gt;/);
});
test('expired bound acceptance displays its original expiry and advisory bounds', () => {
  const {expected, packet} = fixture();
  expected.owner_disposition = {...risk(expected), expires_at: '2026-10-13T00:00:00Z'};
  const report = generateReview(packet, expected);
  assert.equal(report.owner_risk_disposition.status, 'EXPIRED');
  assert.match(renderHtml(report), /2026-10-13T00:00:00Z/);
  retained(report);
});

test('comparable audits accept a nonempty production subset', () => {
  const {expected, packet} = fixture();
  replaceSummary(packet, productionSubset);
  const report = generateReview(packet, expected);
  assert.equal(report.audit_comparison.status, 'SUBSET_CONFIRMED');
  assert.equal(report.consistency, 'PASSED');
  retained(report);
});
for (const [name, change] of [
  ['record outside full audit', summary => { summary.results.dependencies_production.findings.records[0] = 'synthetic-unobserved'; }],
  ['advisory outside full audit', summary => { summary.results.dependencies_production.findings.advisory_ids = ['GHSA-unobserved-synthetic']; }],
  ['severity outside full audit', summary => {
    const counts = summary.results.dependencies_production.findings.severity_counts;
    counts.high = 0; counts.critical = 2;
  }],
  ['production count exceeds full', summary => {
    const production = summary.results.dependencies_production.findings;
    production.records = Array.from({length: 6}, (_, index) => 'synthetic-package-' + (index + 1));
    production.count = 6; production.severity_counts.high = 6; production.severity_counts.total = 6;
  }],
  ['full audit has zero findings', summary => {
    const full = summary.results.dependencies_full;
    full.findings.records = []; full.findings.advisory_ids = []; full.findings.count = 0;
    full.findings.severity_counts.high = 0; full.findings.severity_counts.total = 0; full.command_exit = 0;
  }],
]) {
  test('rejects contradictory comparable audits: ' + name, () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => { productionSubset(summary); change(summary); });
    assert.throws(() => generateReview(packet, expected), /production audit findings contradict/);
  });
}
for (const name of ['dependencies_full', 'dependencies_production', 'both']) {
  test('missing audit snapshot remains incomplete: ' + name, () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => {
      for (const key of ['dependencies_full', 'dependencies_production']) {
        if (name === 'both' || key === name) delete summary.results[key].snapshot;
      }
    });
    const report = generateReview(packet, expected);
    assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
    assert.equal(report.audit_comparison.status, 'NOT_ESTABLISHED');
    retained(report);
  });
}
for (const field of ['lockfile_sha256', 'advisory_snapshot_sha256']) {
  test('different ' + field + ' does not imply comparable audit snapshots', () => {
    const {expected, packet} = fixture();
    replaceSummary(packet, summary => {
      productionSubset(summary);
      summary.results.dependencies_production.findings.records[0] = 'synthetic-new-snapshot-record';
      summary.results.dependencies_production.snapshot[field] = 'f'.repeat(64);
    });
    const report = generateReview(packet, expected);
    assert.equal(report.audit_comparison.status, 'DIFFERENT_SNAPSHOTS');
    assert.equal(report.consistency, 'INCOMPLETE_AUDIT_COMPARABILITY');
    retained(report);
  });
}
test('invalid snapshot digests cannot establish audit comparability', () => {
  const {expected, packet} = fixture();
  replaceSummary(packet, summary => { summary.results.dependencies_full.snapshot.lockfile_sha256 = 'not-a-digest'; });
  assert.throws(() => generateReview(packet, expected), /invalid digest/);
});

for (const invalid of ['2026-02-30T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-01-00T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z']) {
  test('rejects calendar-invalid review time ' + invalid, () => {
    const {expected, packet} = fixture();
    expected.reviewed_at = invalid;
    assert.throws(() => generateReview(packet, expected), /invalid UTC timestamp/);
  });
}
for (const field of ['expiry', 'capture']) {
  test('rejects calendar-invalid ' + field, () => {
    const {expected, packet} = fixture();
    if (field === 'expiry') expected.owner_disposition = {...risk(expected), expires_at: '2026-02-30T00:00:00Z'};
    else { packet.model = modelFixture(); packet.model.source.captured_at = '2026-02-30T00:00:00Z'; }
    assert.throws(() => generateReview(packet, expected), /invalid UTC timestamp/);
  });
}
for (const valid of ['2028-02-29T12:34:56Z', '2028-02-29T12:34:56.1Z', '2028-02-29T12:34:56.12Z', '2028-02-29T12:34:56.123Z']) {
  test('accepts calendar-valid UTC timestamp ' + valid, () => {
    const {expected, packet} = fixture();
    expected.reviewed_at = valid;
    retained(generateReview(packet, expected));
  });
}
test('future model capture cannot be labelled historical', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture(); packet.model.source.captured_at = '2026-10-14T20:00:00.001Z';
  assert.throws(() => generateReview(packet, expected), /postdates review/);
});
test('model capture exactly at review time is not future-dated', () => {
  const {expected, packet} = fixture();
  packet.model = modelFixture(); packet.model.source.captured_at = expected.reviewed_at;
  retained(generateReview(packet, expected));
});

for (const [name, rewrite] of [
  ['summary identity', raw => raw.replace('"project":"42"', '"project":"999","project":"42"')],
  ['escaped summary identity', raw => raw.replace('"project":"42"', '"\\u0070roject":"999","project":"42"')],
  ['nested coverage member', raw => raw.replace('"status":"COMPLETE"', '"status":"INCOMPLETE","status":"COMPLETE"')],
]) {
  test('rejects duplicate JSON members with recomputed integrity: ' + name, () => {
    const {expected, packet} = fixture();
    rawArtifact(packet, 'qc_summary', rewrite(packet.qc_summary_raw));
    assert.throws(() => generateReview(packet, expected), /duplicate JSON member/);
  });
}
test('rejects duplicate members in raw validation exits', () => {
  const {expected, packet} = fixture();
  rawArtifact(packet, 'validation_exits', '{"assessor":0,"tests":1,"tests":0,"typecheck":0,"lint":0,"build":0}');
  assert.throws(() => generateReview(packet, expected), /duplicate JSON member/);
});
test('duplicate detection traverses deeply nested arrays iteratively', () => {
  assert.throws(() => parseJson('['.repeat(2000) + '{"k":1,"k":2}' + ']'.repeat(2000), 'synthetic'), /duplicate JSON member/);
});
test('same keys in separate objects and braces in escaped strings are unambiguous', () => {
  const value = {items: [{k: 1}, {k: 2}], text: '"project": "42", {} [] \\'};
  assert.deepEqual(parseJson(JSON.stringify(value), 'synthetic'), value);
});

function cliCase(setup, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-corrections-'));
  try {
    const {expected, packet} = fixture();
    const paths = {expected: path.join(directory, 'expected.json'), packet: path.join(directory, 'packet.json')};
    fs.writeFileSync(paths.expected, JSON.stringify(expected));
    fs.writeFileSync(paths.packet, JSON.stringify(packet));
    const output = path.join(directory, 'output');
    setup({directory, paths, output});
    const saved = Object.fromEntries(Object.entries(paths).map(([key, filename]) => [key, fs.readFileSync(filename)]));
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--expected', paths.expected, '--packet', paths.packet, '--out', output], {encoding: 'utf8', timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    check({result, paths, output, saved});
    for (const [key, filename] of Object.entries(paths)) assert.deepEqual(fs.readFileSync(filename), saved[key], 'input bytes must be preserved');
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
for (const key of ['expected', 'packet']) {
  test('CLI rejects duplicate JSON members in ' + key, () => {
    cliCase(({paths}) => {
      const raw = fs.readFileSync(paths[key], 'utf8');
      fs.writeFileSync(paths[key], raw.replace('{"contract":', '{"contract":"synthetic-contradiction","contract":'));
    }, ({result, output}) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /duplicate JSON member/);
      assert.equal(fs.existsSync(output), false);
    });
  });
  for (const name of ['review.json', 'review.html']) {
    for (const alias of ['input-symlink', 'output-symlink', 'hard-link']) {
      test('CLI preserves ' + key + ' through ' + alias + ' alias of ' + name, () => {
        cliCase(({paths, output}) => {
          fs.mkdirSync(output);
          const target = path.join(output, name);
          if (alias === 'input-symlink') {
            fs.renameSync(paths[key], target);
            fs.symlinkSync(target, paths[key]);
          } else if (alias === 'output-symlink') fs.symlinkSync(paths[key], target);
          else fs.linkSync(paths[key], target);
        }, ({result, output}) => {
          assert.equal(result.status, 2);
          assert.equal(result.stderr, 'output must not overwrite an input\n');
          assert.equal(result.stdout, '');
          assert.equal(fs.existsSync(path.join(output, name === 'review.json' ? 'review.html' : 'review.json')), false);
        });
      });
    }
  }
}
test('CLI detects input alias through a symlinked parent directory', () => {
  cliCase(({directory, paths, output}) => {
    fs.mkdirSync(output);
    const target = path.join(output, 'review.json');
    fs.renameSync(paths.expected, target);
    const alias = path.join(directory, 'output-alias');
    fs.symlinkSync(output, alias, 'dir');
    paths.expected = path.join(alias, 'review.json');
  }, ({result}) => {
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'output must not overwrite an input\n');
  });
});

for (const alias of ['hard-link', 'html-symlink', 'json-symlink', 'two-symlinks']) {
  test('CLI rejects aliased output files before truncation: ' + alias, () => {
    const original = 'synthetic pre-existing output bytes\n';
    cliCase(({directory, output}) => {
      fs.mkdirSync(output);
      const json = path.join(output, 'review.json');
      const html = path.join(output, 'review.html');
      if (alias === 'hard-link') {
        fs.writeFileSync(json, original);
        fs.linkSync(json, html);
      } else if (alias === 'html-symlink') {
        fs.writeFileSync(json, original);
        fs.symlinkSync(json, html);
      } else if (alias === 'json-symlink') {
        fs.writeFileSync(html, original);
        fs.symlinkSync(html, json);
      } else {
        const shared = path.join(directory, 'synthetic-shared-output');
        fs.writeFileSync(shared, original);
        fs.symlinkSync(shared, json);
        fs.symlinkSync(shared, html);
      }
    }, ({result, output}) => {
      assert.equal(result.status, 2);
      assert.equal(result.stderr, 'output files must be distinct\n');
      assert.equal(result.stdout, '');
      for (const name of ['review.json', 'review.html']) {
        assert.equal(fs.readFileSync(path.join(output, name), 'utf8'), original, 'neither destination may be truncated');
      }
    });
  });
}

const dependencyHtmlRow = (html, name) => {
  const match = html.match(new RegExp('<tr><td>' + name + '</td>.*?</tr>'));
  assert.ok(match, 'dependency audit row must be visible');
  return match[0];
};
test('HTML displays all dependency severity counts and affected records', () => {
  const {expected, packet} = fixture();
  const report = generateReview(packet, expected);
  const html = renderHtml(report);
  assert.ok(html.includes('<th>Affected dependency records</th>'));
  assert.ok(html.includes('<th>Dependency severities</th>'));
  const full = dependencyHtmlRow(html, 'dependencies_full');
  for (const value of ['Info: 0', 'Low: 0', 'Moderate: 0', 'High: 5', 'Critical: 0', 'Total: 5']) assert.ok(full.includes(value));
  for (const record of report.findings.find(row => row.name === 'dependencies_full').records) assert.ok(full.includes(record));
  const production = dependencyHtmlRow(html, 'dependencies_production');
  for (const value of ['Info: 0', 'Low: 0', 'Moderate: 0', 'High: 0', 'Critical: 0', 'Total: 0']) assert.ok(production.includes(value));
  retained(report);
});
for (const severity of ['low', 'critical']) {
  test('HTML distinguishes five ' + severity + ' findings from five High findings', () => {
    const {expected, packet} = fixture();
    const high = dependencyHtmlRow(renderHtml(generateReview(packet, expected)), 'dependencies_full');
    replaceSummary(packet, summary => {
      const counts = summary.results.dependencies_full.findings.severity_counts;
      counts.high = 0;
      counts[severity] = 5;
    });
    const report = generateReview(packet, expected);
    const row = dependencyHtmlRow(renderHtml(report), 'dependencies_full');
    assert.ok(row.includes(severity[0].toUpperCase() + severity.slice(1) + ': 5'));
    assert.ok(row.includes('High: 0'));
    assert.notEqual(row, high);
    retained(report);
  });
}
test('HTML escapes affected dependency records and advisory IDs beside severity counts', () => {
  const {expected, packet} = fixture();
  replaceSummary(packet, summary => {
    const findings = summary.results.dependencies_full.findings;
    findings.records[0] = '<img src=x onerror="synthetic"> & \'record\'';
    findings.advisory_ids = ['<script>synthetic & "advisory"</script>'];
  });
  const html = renderHtml(generateReview(packet, expected));
  const row = dependencyHtmlRow(html, 'dependencies_full');
  assert.ok(!html.includes('<img ') && !html.includes('<script>'));
  assert.ok(row.includes('&lt;img src=x onerror=&quot;synthetic&quot;&gt; &amp; &#39;record&#39;'));
  assert.ok(row.includes('&lt;script&gt;synthetic &amp; &quot;advisory&quot;&lt;/script&gt;'));
  assert.ok(row.includes('High: 5'));
});

for (const name of ['dependencies_full', 'dependencies_production']) {
  test('rejects advisory IDs on zero-finding audit: ' + name, () => {
    const {expected, packet} = fixture({findings: false});
    replaceSummary(packet, summary => {
      summary.results[name].findings.advisory_ids = ['GHSA-synthetic-contradiction'];
    });
    assert.throws(() => generateReview(packet, expected), /zero audit findings must not contain advisory IDs/);
  });
}
