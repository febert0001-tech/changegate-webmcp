import {createHash} from 'node:crypto';

export const REPORT_VERSION = 'releaseproof-review/v1';
export const JOB_NAMES = Object.freeze([
  'application-validation', 'semgrep-sast', 'secret_detection',
  'npm-dependency-audit', 'qc-assessment',
]);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const MAX_TEXT = 16_384;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

export class EvidenceError extends Error {
  constructor(message) { super(message); this.name = 'EvidenceError'; }
}
const requireEvidence = (condition, message) => {
  if (!condition) throw new EvidenceError(message);
};
const exactKeys = (value, required, optional, label) => {
  requireEvidence(record(value), `${label}: expected an object`);
  requireEvidence(required.every(key => Object.hasOwn(value, key)), `${label}: missing field`);
  const allowed = new Set([...required, ...optional]);
  requireEvidence(Object.keys(value).every(key => allowed.has(key)), `${label}: unexpected field`);
};
const id = (value, label) => {
  requireEvidence((typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d*$/.test(String(value)), `${label}: invalid ID`);
  return String(value);
};
const sha = (value, label) => {
  requireEvidence(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), `${label}: invalid SHA`);
  return value;
};
const text = (value, label, max = MAX_TEXT) => {
  requireEvidence(typeof value === 'string' && value.length <= max, `${label}: invalid text`);
  return value;
};
const strings = (value, label) => {
  requireEvidence(Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'string' && item.length <= 256), `${label}: invalid string list`);
  requireEvidence(value.every(item => item.trim().length > 0), `${label}: blank entry`);
  requireEvidence(new Set(value).size === value.length, `${label}: duplicate values`);
  return [...value];
};
const timestamp = (value, label) => {
  requireEvidence(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), `${label}: invalid UTC timestamp`);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => '.' + fraction.padEnd(3, '0') + 'Z');
  requireEvidence(new Date(value).toISOString() === normalized, `${label}: invalid UTC timestamp`);
  return value;
};
const wellFormedUnicode = value => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
const validateUnicode = (value, label) => {
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      requireEvidence(!current.includes('\u0000'), `${label}: null character`);
      requireEvidence(wellFormedUnicode(current), `${label}: unpaired Unicode surrogate`);
    } else if (current !== null && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
    }
  }
};
// Native parsing checks the grammar; validation rejects unpaired surrogates
// throughout parsed values and keys without changing evidence. The token walk rejects
// ambiguous object members, including names encoded with JSON escapes.
export function parseJson(raw, label) {
  try {
    const value = JSON.parse(raw);
    validateUnicode(value, label);
    const containers = [];
    const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g;
    for (const match of raw.matchAll(tokens)) {
      const token = match[0];
      if (token === '{') containers.push(new Set());
      else if (token === '[') containers.push(null);
      else if (token === '}' || token === ']') containers.pop();
      else {
        let next = match.index + token.length;
        while (next < raw.length && /[ \t\r\n]/.test(raw[next])) next++;
        if (raw[next] === ':') {
          const name = JSON.parse(token);
          const names = containers.at(-1);
          requireEvidence(!names.has(name), `${label}: duplicate JSON member`);
          names.add(name);
        }
      }
    }
    return value;
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError(`${label}: malformed JSON`);
  }
}
const readJson = (raw, label) => {
  requireEvidence(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 262_144, `${label}: invalid or oversized bytes`);
  try {
    const value = parseJson(raw, label);
    requireEvidence(record(value), `${label}: expected an object`);
    return value;
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError(`${label}: malformed JSON`);
  }
};

export const digest = raw => createHash('sha256').update(raw, 'utf8').digest('hex');
const sortedValue = value => {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]));
  return value;
};
export const canonicalJson = value => JSON.stringify(sortedValue(value), null, 2) + '\n';

function expectation(value) {
  exactKeys(value, ['contract', 'project', 'sha', 'pipeline', 'jobs', 'reviewed_at'], ['owner_disposition'], 'expectation');
  requireEvidence(value.contract === 'releaseproof-expectation/v1', 'expectation: wrong contract');
  exactKeys(value.jobs, JOB_NAMES, [], 'expected jobs');
  const jobs = Object.fromEntries(JOB_NAMES.map(name => [name, id(value.jobs[name], 'expected job')]));
  requireEvidence(new Set(Object.values(jobs)).size === JOB_NAMES.length, 'expected jobs: duplicate IDs');
  return {project: id(value.project, 'expected project'), sha: sha(value.sha, 'expected commit'), pipeline: id(value.pipeline, 'expected pipeline'),
    jobs, reviewed_at: timestamp(value.reviewed_at, 'review time'), owner_disposition: value.owner_disposition};
}

function nativeJobs(native, expected) {
  exactKeys(native, ['project', 'commit', 'pipeline', 'jobs'], [], 'native receipts');
  requireEvidence(record(native.project) && id(native.project.id, 'native project') === expected.project, 'native project mismatch');
  requireEvidence(record(native.commit) && sha(native.commit.id, 'native commit') === expected.sha, 'native commit mismatch');
  const pipeline = native.pipeline;
  requireEvidence(record(pipeline) && id(pipeline.id, 'native pipeline') === expected.pipeline && id(pipeline.project_id, 'pipeline project') === expected.project && sha(pipeline.sha, 'pipeline commit') === expected.sha, 'native pipeline mismatch');
  requireEvidence(['success', 'failed'].includes(pipeline.status), 'native pipeline is not a completed result');
  requireEvidence(Array.isArray(native.jobs) && native.jobs.length === JOB_NAMES.length, 'native jobs: wrong count');
  const jobs = JOB_NAMES.map(name => {
    const matching = native.jobs.filter(job => record(job) && job.name === name);
    requireEvidence(matching.length === 1, 'native jobs: missing or duplicate name');
    const job = matching[0];
    requireEvidence(id(job.id, 'native job') === expected.jobs[name], 'native job ID mismatch');
    requireEvidence(record(job.commit) && sha(job.commit.id, 'job commit') === expected.sha, 'native job commit mismatch');
    requireEvidence(record(job.pipeline) && id(job.pipeline.id, 'job pipeline') === expected.pipeline && id(job.pipeline.project_id, 'job project') === expected.project && sha(job.pipeline.sha, 'job pipeline commit') === expected.sha, 'native job pipeline mismatch');
    requireEvidence(job.pipeline.status === pipeline.status, 'native job pipeline status contradicts pipeline receipt');
    requireEvidence(['success', 'failed'].includes(job.status), 'native job is missing, skipped or unfinished');
    requireEvidence(name === 'qc-assessment' || job.status === 'success', 'required command or scanner execution failed');
    return {name, id: expected.jobs[name], status: job.status};
  });
  return {pipeline_status: pipeline.status, jobs};
}

function artifact(raw, provenance, expected, jobName, path) {
  exactKeys(provenance, ['source_kind', 'project', 'sha', 'pipeline', 'job', 'path', 'sha256', 'byte_count'], [], 'artifact provenance');
  requireEvidence(['native-artifact', 'trace-derived', 'synthetic-fixture'].includes(provenance.source_kind), 'artifact provenance: unsupported source');
  requireEvidence(id(provenance.project, 'artifact project') === expected.project && sha(provenance.sha, 'artifact commit') === expected.sha && id(provenance.pipeline, 'artifact pipeline') === expected.pipeline && id(provenance.job, 'artifact job') === expected.jobs[jobName] && provenance.path === path, 'artifact provenance identity mismatch');
  requireEvidence(typeof raw === 'string' && integer(provenance.byte_count) && provenance.byte_count === Buffer.byteLength(raw, 'utf8'), 'artifact byte count mismatch');
  const actual = digest(raw);
  requireEvidence(provenance.sha256 === actual, 'artifact digest mismatch');
  const data = readJson(raw, 'artifact');
  return {data, receipt: {source_kind: provenance.source_kind, job: expected.jobs[jobName], path, sha256: actual, byte_count: provenance.byte_count}};
}

function toolMetadata(value) {
  exactKeys(value, ['id', 'name', 'url', 'vendor', 'version'], [], 'tool metadata');
  exactKeys(value.vendor, ['name'], [], 'tool vendor');
  const field = (value, max = 256) => {
    const supplied = text(value, 'tool metadata', max);
    requireEvidence(supplied.trim().length > 0, 'tool metadata: blank text');
    return supplied;
  };
  // URLs are bounded opaque evidence text, never navigation targets.
  return {id: field(value.id), name: field(value.name), url: field(value.url, 2048),
    vendor: {name: field(value.vendor.name)}, version: field(value.version)};
}

function summaryResult(value, expected) {
  exactKeys(value, ['project', 'sha', 'pipeline', 'results', 'coverage_complete', 'findings_present', 'status', 'historical_audit_waiver', 'historical_unknowns', 'g0', 'g1'], [], 'QC summary');
  requireEvidence(id(value.project, 'summary project') === expected.project && sha(value.sha, 'summary commit') === expected.sha && id(value.pipeline, 'summary pipeline') === expected.pipeline, 'summary identity mismatch');
  exactKeys(value.results, ['sast', 'secrets', 'dependencies_full', 'dependencies_production'], [], 'summary results');
  const mapping = {sast: 'semgrep-sast', secrets: 'secret_detection', dependencies_full: 'npm-dependency-audit', dependencies_production: 'npm-dependency-audit'};
  const results = Object.entries(mapping).map(([name, jobName]) => {
    const result = value.results[name];
    const dependency = name.startsWith('dependencies_');
    exactKeys(result, ['execution', 'coverage', 'findings', ...(dependency ? ['command_exit'] : [])], dependency ? ['snapshot'] : ['analyzer', 'scanner'], 'summary result');
    exactKeys(result.execution, ['status', 'job', 'exit'], ['issues', ...(name === 'sast' ? ['target_exit'] : [])], 'summary execution');
    exactKeys(result.coverage, ['status', 'issues'], [], 'summary coverage');
    requireEvidence(record(result) && record(result.execution) && result.execution.status === 'SUCCEEDED' && id(result.execution.job, 'scan job') === expected.jobs[jobName] && result.execution.exit === 0, 'summary execution mismatch or failure');
    if (Object.hasOwn(result.execution, 'issues')) requireEvidence(Array.isArray(result.execution.issues) && result.execution.issues.length === 0, 'summary execution issues: unsuccessful or incomplete');
    if (Object.hasOwn(result.execution, 'target_exit')) requireEvidence(result.execution.target_exit === 0, 'summary target execution failed or incomplete');
    requireEvidence(record(result.coverage) && result.coverage.status === 'COMPLETE' && Array.isArray(result.coverage.issues) && result.coverage.issues.length === 0, 'summary coverage incomplete');
    const findings = result.findings;
    exactKeys(findings, ['status', 'count', ...(dependency ? ['records', 'advisory_ids', 'severity_counts'] : ['ids'])], ['target_count', ...(name === 'sast' ? ['details'] : [])], 'summary findings');
    requireEvidence(record(findings) && findings.status === 'KNOWN' && integer(findings.count), 'summary findings incomplete');
    const entries = strings(name.startsWith('dependencies_') ? findings.records : findings.ids, 'findings');
    requireEvidence(entries.length === findings.count, 'findings count mismatch');
    if (Object.hasOwn(findings, 'target_count')) requireEvidence(integer(findings.target_count) && findings.target_count <= findings.count, 'target findings disagree');
    const row = {name, execution: 'SUCCEEDED', coverage: 'COMPLETE', findings_count: findings.count, records: entries};
    if (Object.hasOwn(result.execution, 'issues')) row.execution_issues = [];
    if (Object.hasOwn(result.execution, 'target_exit')) row.target_exit = result.execution.target_exit;
    if (Object.hasOwn(findings, 'details')) {
      requireEvidence(findings.count === 0 && Array.isArray(findings.details) && findings.details.length === 0, 'summary findings details: unsupported shape');
      row.details = [];
    }
    for (const kind of ['analyzer', 'scanner']) {
      if (Object.hasOwn(result, kind)) row[kind] = toolMetadata(result[kind]);
    }
    if (Object.hasOwn(findings, 'target_count')) row.target_count = findings.target_count;
    if (name.startsWith('dependencies_')) {
      const counts = findings.severity_counts;
      exactKeys(counts, [...SEVERITIES, 'total'], [], 'dependency severities');
      requireEvidence(record(counts) && [...SEVERITIES, 'total'].every(key => integer(counts[key])) && counts.total === findings.count && SEVERITIES.reduce((total, key) => total + counts[key], 0) === counts.total, 'dependency severity counts disagree');
      requireEvidence(result.command_exit === (findings.count > 0 ? 1 : 0), 'audit command exit disagrees with findings');
      row.command_exit = result.command_exit;
      row.severity_counts = Object.fromEntries([...SEVERITIES, 'total'].map(key => [key, counts[key]]));
      row.advisory_ids = strings(findings.advisory_ids, 'advisories');
      requireEvidence(findings.count !== 0 || row.advisory_ids.length === 0, 'zero audit findings must not contain advisory IDs');
    }
    return row;
  });
  const findingsPresent = results.some(result => result.findings_count > 0);
  requireEvidence(value.coverage_complete === true && value.findings_present === findingsPresent && value.status === (findingsPresent ? 'FINDINGS' : 'NO_FINDINGS_IN_REPORTED_COVERAGE'), 'summary verdict disagrees with results');
  requireEvidence(value.historical_audit_waiver === false, 'historical audit waiver changed');
  requireEvidence(value.g0 === 'OPEN / NOT APPROVED' && value.g1 === 'CLOSED', 'summary cannot grant a gate approval');
  const unknowns = strings(value.historical_unknowns, 'historical unknowns');
  requireEvidence(unknowns.includes('diagnostic_artifact_capture_time') && unknowns.includes('lifecycle_approval_configuration_comparison'), 'historical unknowns were removed');
  return {results, findings_present: findingsPresent, historical_unknowns: unknowns,
    audit_comparison: compareAudits(value.results, results)};
}

function compareAudits(supplied, rows) {
  const snapshots = ['dependencies_full', 'dependencies_production'].map(name => {
    const value = supplied[name].snapshot;
    if (value === undefined) return null;
    exactKeys(value, ['lockfile_sha256', 'advisory_snapshot_sha256'], [], 'audit snapshot');
    requireEvidence(Object.values(value).every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)), 'audit snapshot: invalid digest');
    return value;
  });
  const declaration = 'Collector-supplied lockfile and advisory snapshot identities; not independently authenticated by this report.';
  if (snapshots.some(value => value === null)) return {status: 'NOT_ESTABLISHED', basis: declaration, reason: 'Both audit snapshot identities are required to establish comparability.', snapshots};
  if (snapshots[0].lockfile_sha256 !== snapshots[1].lockfile_sha256 || snapshots[0].advisory_snapshot_sha256 !== snapshots[1].advisory_snapshot_sha256) {
    return {status: 'DIFFERENT_SNAPSHOTS', basis: declaration, reason: 'Audit snapshots differ; no subset relationship is inferred.', snapshots};
  }
  const full = rows.find(row => row.name === 'dependencies_full');
  const production = rows.find(row => row.name === 'dependencies_production');
  requireEvidence(production.records.every(value => full.records.includes(value)) &&
    production.advisory_ids.every(value => full.advisory_ids.includes(value)) &&
    production.findings_count <= full.findings_count &&
    [...SEVERITIES, 'total'].every(key => production.severity_counts[key] <= full.severity_counts[key]), 'production audit findings contradict comparable full audit');
  return {status: 'SUBSET_CONFIRMED', basis: declaration, snapshot: snapshots[0]};
}

function disposition(value, expected, findings) {
  if (value === undefined) return {status: 'NOT_SUPPLIED', grants_release: false};
  exactKeys(value, ['status', 'scope', 'project', 'sha', 'expires_at', 'advisory_ids'], ['pipeline'], 'owner disposition');
  requireEvidence(value.status === 'ACCEPTED' && value.scope === 'contest-only', 'owner disposition: unsupported scope');
  requireEvidence(id(value.project, 'disposition project') === expected.project && sha(value.sha, 'disposition commit') === expected.sha, 'owner disposition identity mismatch');
  const expires = timestamp(value.expires_at, 'disposition expiry');
  const advisories = strings(value.advisory_ids, 'disposition advisories');
  const observed = [...new Set(findings.flatMap(row => row.advisory_ids ?? []))];
  requireEvidence(advisories.length > 0 && advisories.every(advisory => observed.includes(advisory)), 'owner disposition advisory mismatch');
  const pipeline = value.pipeline === undefined ? null : id(value.pipeline, 'disposition pipeline');
  requireEvidence(pipeline === null || pipeline === expected.pipeline, 'owner disposition pipeline mismatch');
  return {status: pipeline === null ? 'UNBOUND_PIPELINE' : Date.parse(expires) > Date.parse(expected.reviewed_at) ? 'RECORDED_ACCEPTANCE' : 'EXPIRED',
    supplied_status: value.status, project: expected.project, sha: expected.sha, pipeline, scope: value.scope, expires_at: expires, advisory_ids: advisories, grants_release: false,
    authenticity: 'HUMAN_SUPPLIED_RECORD_NOT_AUTHENTICATED_BY_THIS_REPORT'};
}

function modelNote(value, reviewedAt) {
  if (value === undefined) return null;
  exactKeys(value, ['text', 'source'], [], 'model note');
  exactKeys(value.source, ['kind', 'id', 'captured_at'], ['input_sha'], 'model provenance');
  requireEvidence(value.source.kind === 'historical-interpretation', 'model note cannot supply current approval');
  const capturedAt = timestamp(value.source.captured_at, 'model capture time');
  requireEvidence(Date.parse(capturedAt) <= Date.parse(reviewedAt), 'model capture time postdates review');
  return {text: text(value.text, 'model text'), source: {kind: 'historical-interpretation', id: id(value.source.id, 'model session'),
    captured_at: capturedAt, input_sha: value.source.input_sha === undefined ? null : sha(value.source.input_sha, 'model input commit')}, authority: 'INTERPRETATION_ONLY'};
}

export function generateReview(packet, trustedExpectation) {
  // Apply the same rule to object callers that parsed their JSON separately.
  validateUnicode(packet, 'packet');
  validateUnicode(trustedExpectation, 'expectation');
  const expected = expectation(trustedExpectation);
  exactKeys(packet, ['contract', 'native', 'qc_summary_raw', 'validation_exits_raw', 'provenance'], ['model'], 'packet');
  requireEvidence(packet.contract === 'releaseproof-packet/v1', 'packet: wrong contract');
  exactKeys(packet.provenance, ['qc_summary', 'validation_exits'], [], 'provenance');
  const native = nativeJobs(packet.native, expected);
  const summary = artifact(packet.qc_summary_raw, packet.provenance.qc_summary, expected, 'qc-assessment', 'qc-summary.json');
  const validation = artifact(packet.validation_exits_raw, packet.provenance.validation_exits, expected, 'application-validation', 'qc-validation/exits.json');
  exactKeys(validation.data, ['assessor', 'tests', 'typecheck', 'lint', 'build'], [], 'application exits');
  requireEvidence(Object.values(validation.data).every(value => value === 0), 'required application command failed');
  const result = summaryResult(summary.data, expected);
  const nativeVerdict = result.findings_present ? 'failed' : 'success';
  requireEvidence(native.pipeline_status === nativeVerdict && native.jobs.find(job => job.name === 'qc-assessment').status === nativeVerdict, 'native assessment or pipeline disagrees with findings');
  const receipts = [summary.receipt, validation.receipt];
  const hasNativeBytes = receipts.every(receipt => receipt.source_kind === 'native-artifact');
  return {contract: REPORT_VERSION, expected: {project: expected.project, sha: expected.sha, pipeline: expected.pipeline, reviewed_at: expected.reviewed_at},
    consistency: result.audit_comparison.status === 'SUBSET_CONFIRMED' ? 'PASSED' : 'INCOMPLETE_AUDIT_COMPARABILITY',
    audit_comparison: result.audit_comparison, provenance_status: hasNativeBytes ? 'NATIVE_BYTES_DECLARED' : 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE',
    provenance_limit: 'Byte integrity and packet consistency only; this report does not authenticate the provider or the collecting actor.',
    command_execution: {status: 'SUCCEEDED', application_exits: validation.data}, jobs: native.jobs, scan_coverage: 'COMPLETE',
    findings: result.results, qc_verdict: nativeVerdict === 'failed' ? 'FAILED_WITH_FINDINGS' : 'NO_FINDINGS_IN_SUPPLIED_COVERAGE',
    native_pipeline_status: native.pipeline_status, artifacts: receipts, historical_unknowns: result.historical_unknowns,
    owner_risk_disposition: disposition(expected.owner_disposition, expected, result.results),
    human_release: {status: 'PENDING', approved: false, authority: 'SEPARATE_HUMAN_DECISION_REQUIRED'},
    deployment: {authorized: false, action: 'NONE'}, model_note: modelNote(packet.model, expected.reviewed_at)};
}

export const escapeHtml = value => String(value).replace(/[&<>"'\r]/g, character => ({'\r': '&#13;', '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

export function renderHtml(report) {
  requireEvidence(record(report) && report.contract === REPORT_VERSION && report.human_release?.approved === false && report.deployment?.authorized === false, 'invalid review output');
  validateUnicode(report, 'review output');
  const e = escapeHtml;
  const evidenceList = values => values.length
    ? `<ul class="evidence-list">${values.map(value => `<li><code class="evidence-text">${e(value)}</code></li>`).join('')}</ul>`
    : '<span class="muted">None reported</span>';
  const cards = [['QC verdict', report.qc_verdict], ['Evidence consistency', report.consistency], ['Artifact provenance', report.provenance_status], ['Human release', report.human_release.status]];
  const jobs = report.jobs.map(job => `<tr><td>${e(job.name)}</td><td>${e(job.id)}</td><td>${e(job.status)}</td></tr>`).join('');
  const findings = report.findings.map(row => {
    const severities = row.severity_counts
      ? [...SEVERITIES, 'total'].map(key => `${key[0].toUpperCase() + key.slice(1)}: ${row.severity_counts[key]}`).join('; ')
      : 'Not applicable';
    return `<tr><td>${e(row.name)}</td><td>${e(row.execution)}</td><td>${e(row.coverage)}</td><td>${e(row.findings_count)}</td><td>${e(Object.hasOwn(row, 'target_count') ? row.target_count : 'Not supplied')}</td><td>${row.severity_counts ? evidenceList(row.records) : '<span class="muted">Not applicable</span>'}</td><td>${evidenceList(row.advisory_ids ?? row.records)}</td><td>${e(severities)}</td></tr>`;
  }).join('');
  const suppliedMetadata = report.findings.filter(row => ['execution_issues', 'target_exit', 'details', 'analyzer', 'scanner'].some(key => Object.hasOwn(row, key)));
  const producerDetails = suppliedMetadata.map(row => {
    const fields = [['Execution issues', 'execution_issues'], ['Target exit', 'target_exit'], ['Finding details', 'details']]
      .map(([label, key]) => `<dt>${e(label)}</dt><dd><code class="evidence-text">${e(Object.hasOwn(row, key) ? canonicalJson(row[key]).trimEnd() : 'Not supplied')}</code></dd>`).join('');
    const tools = ['analyzer', 'scanner'].map(kind => {
      const tool = row[kind];
      return `<h4>${e(kind)}</h4>` + (tool ? `<dl>${[['ID', tool.id], ['Name', tool.name], ['URL (inert text)', tool.url], ['Vendor name', tool.vendor.name], ['Version', tool.version]]
        .map(([label, value]) => `<dt>${e(label)}</dt><dd><code class="evidence-text">${e(value)}</code></dd>`).join('')}</dl>` : '<p class="muted">Not supplied</p>');
    }).join('');
    return `<h3>${e(row.name)}</h3><dl>${fields}</dl>${tools}`;
  }).join('');
  const snapshots = report.audit_comparison.snapshots ??
    [report.audit_comparison.snapshot ?? null, report.audit_comparison.snapshot ?? null];
  const snapshotDetails = snapshots.map((snapshot, index) =>
    `<h3>${e(['dependencies_full', 'dependencies_production'][index])}</h3>` +
    (snapshot ? `<dl><dt>Lockfile SHA-256</dt><dd><code>${e(snapshot.lockfile_sha256)}</code></dd><dt>Advisory snapshot SHA-256</dt><dd><code>${e(snapshot.advisory_snapshot_sha256)}</code></dd></dl>`
      : '<p class="muted">Snapshot identities not supplied.</p>')).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ChangeGate · Release review</title>
<style>body{margin:0;background:#f3f5f8;color:#182330;font:16px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:40px 24px}h1{margin:0;font-size:34px;letter-spacing:-.8px}h2{font-size:20px;margin:28px 0 12px}.eyebrow{font-weight:700;color:#405a78;letter-spacing:1px;font-size:12px}.muted{color:#526174}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:24px 0}.card,section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:18px}.card small{display:block;color:#526174;margin-bottom:8px}.card strong{display:block;font-size:14px;overflow-wrap:anywhere}.warning{border-left:5px solid #b56112;padding:14px 18px;background:#fff5e7;border-radius:6px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e2e7ed}code{font-size:13px;overflow-wrap:anywhere}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.note{white-space:pre-wrap}footer{margin-top:24px;font-size:12px;color:#526174}.evidence-list{margin:0;padding-left:20px}.evidence-list li{margin:4px 0}.evidence-text{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><main><div class="eyebrow">CHANGEGATE RELEASEPROOF</div><h1>Release review</h1><p class="muted">Project ${e(report.expected.project)} · Pipeline ${e(report.expected.pipeline)}<br>Reviewed commit <code>${e(report.expected.sha)}</code> · Review time ${e(report.expected.reviewed_at)}</p>
<div class="warning"><strong>Human release approval is pending.</strong> This report supplies evidence for review. It performs no deployment and grants no release authority.</div>
<div class="cards">${cards.map(([label, value]) => `<div class="card"><small>${e(label)}</small><strong>${e(value)}</strong></div>`).join('')}</div>
<h2>Required jobs</h2><section class="table"><table><thead><tr><th>Job</th><th>ID</th><th>Native status</th></tr></thead><tbody>${jobs}</tbody></table></section>
<h2>Execution, coverage and findings</h2><section class="table"><table><thead><tr><th>Check</th><th>Execution</th><th>Coverage</th><th>Findings count</th><th>Target findings</th><th>Affected dependency records</th><th>Advisory / finding IDs</th><th>Dependency severities</th></tr></thead><tbody>${findings}</tbody></table></section>
${suppliedMetadata.length ? `<h2>Producer execution and tool metadata</h2><section>${producerDetails}</section>` : ''}
<h2>Audit comparability</h2><section><strong>${e(report.audit_comparison.status)}</strong><p>${e(report.audit_comparison.reason ?? 'Production findings are a subset under the declared comparable snapshots.')}</p><p class="muted">${e(report.audit_comparison.basis)}</p>${snapshotDetails}</section>
<h2>Risk disposition</h2><section><strong>${e(report.owner_risk_disposition.status)}</strong>${report.owner_risk_disposition.scope ? `<dl><dt>Supplied decision</dt><dd>${e(report.owner_risk_disposition.supplied_status)}</dd><dt>Scope</dt><dd>${e(report.owner_risk_disposition.scope)}</dd><dt>Pipeline binding</dt><dd>${e(report.owner_risk_disposition.pipeline ?? 'Not supplied; decision is not attributed to this pipeline')}</dd><dt>Expiry (UTC)</dt><dd>${e(report.owner_risk_disposition.expires_at)}</dd><dt>Accepted advisory IDs</dt><dd>${evidenceList(report.owner_risk_disposition.advisory_ids)}</dd></dl>` : ''}<p class="muted">Acceptance applies only to the displayed bounds. A recorded risk acceptance does not change the QC verdict or grant release approval.</p></section>
<h2>Historical unknowns</h2><section><ul>${report.historical_unknowns.map(unknown => `<li>${e(unknown)}</li>`).join('')}</ul></section>
${report.model_note ? `<h2>Historical model interpretation</h2><section><p class="muted">Session ${e(report.model_note.source.id)} · ${e(report.model_note.source.captured_at)} · Interpretation only</p><p class="muted">Historical model input commit: <code>${e(report.model_note.source.input_sha ?? 'Not supplied')}</code></p><div class="note">${e(report.model_note.text)}</div></section>` : ''}
<h2>Receipt and byte-integrity details</h2><section><p class="muted">${e(report.provenance_limit)}</p><pre>${e(canonicalJson({artifacts: report.artifacts, human_release: report.human_release, deployment: report.deployment}))}</pre></section>
<footer>${e(REPORT_VERSION)} · Offline, deterministic report · No scripts or external resources</footer></main></body></html>\n`;
}
