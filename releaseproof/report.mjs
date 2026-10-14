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
  requireEvidence(new Set(value).size === value.length, `${label}: duplicate values`);
  return [...value];
};
const timestamp = (value, label) => {
  requireEvidence(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), `${label}: invalid UTC timestamp`);
  return value;
};
const readJson = (raw, label) => {
  requireEvidence(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 262_144, `${label}: invalid or oversized bytes`);
  try {
    const value = JSON.parse(raw);
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

function summaryResult(value, expected) {
  requireEvidence(id(value.project, 'summary project') === expected.project && sha(value.sha, 'summary commit') === expected.sha && id(value.pipeline, 'summary pipeline') === expected.pipeline, 'summary identity mismatch');
  exactKeys(value.results, ['sast', 'secrets', 'dependencies_full', 'dependencies_production'], [], 'summary results');
  const mapping = {sast: 'semgrep-sast', secrets: 'secret_detection', dependencies_full: 'npm-dependency-audit', dependencies_production: 'npm-dependency-audit'};
  const results = Object.entries(mapping).map(([name, jobName]) => {
    const result = value.results[name];
    requireEvidence(record(result) && record(result.execution) && result.execution.status === 'SUCCEEDED' && id(result.execution.job, 'scan job') === expected.jobs[jobName] && result.execution.exit === 0, 'summary execution mismatch or failure');
    requireEvidence(record(result.coverage) && result.coverage.status === 'COMPLETE' && Array.isArray(result.coverage.issues) && result.coverage.issues.length === 0, 'summary coverage incomplete');
    const findings = result.findings;
    requireEvidence(record(findings) && findings.status === 'KNOWN' && integer(findings.count), 'summary findings incomplete');
    const entries = strings(name.startsWith('dependencies_') ? findings.records : findings.ids, 'findings');
    requireEvidence(entries.length === findings.count, 'findings count mismatch');
    if (findings.target_count !== undefined) requireEvidence(integer(findings.target_count) && findings.target_count <= findings.count, 'target findings disagree');
    const row = {name, execution: 'SUCCEEDED', coverage: 'COMPLETE', findings_count: findings.count, records: entries};
    if (name.startsWith('dependencies_')) {
      const counts = findings.severity_counts;
      requireEvidence(record(counts) && [...SEVERITIES, 'total'].every(key => integer(counts[key])) && counts.total === findings.count && SEVERITIES.reduce((total, key) => total + counts[key], 0) === counts.total, 'dependency severity counts disagree');
      requireEvidence(result.command_exit === (findings.count > 0 ? 1 : 0), 'audit command exit disagrees with findings');
      row.command_exit = result.command_exit;
      row.severity_counts = Object.fromEntries([...SEVERITIES, 'total'].map(key => [key, counts[key]]));
      row.advisory_ids = strings(findings.advisory_ids, 'advisories');
    }
    return row;
  });
  const findingsPresent = results.some(result => result.findings_count > 0);
  requireEvidence(value.coverage_complete === true && value.findings_present === findingsPresent && value.status === (findingsPresent ? 'FINDINGS' : 'NO_FINDINGS_IN_REPORTED_COVERAGE'), 'summary verdict disagrees with results');
  requireEvidence(value.historical_audit_waiver === false, 'historical audit waiver changed');
  requireEvidence(value.g0 === 'OPEN / NOT APPROVED' && value.g1 === 'CLOSED', 'summary cannot grant a gate approval');
  const unknowns = strings(value.historical_unknowns, 'historical unknowns');
  requireEvidence(unknowns.includes('diagnostic_artifact_capture_time') && unknowns.includes('lifecycle_approval_configuration_comparison'), 'historical unknowns were removed');
  return {results, findings_present: findingsPresent, historical_unknowns: unknowns};
}

function disposition(value, expected, findings) {
  if (value === undefined) return {status: 'NOT_SUPPLIED', grants_release: false};
  exactKeys(value, ['status', 'scope', 'project', 'sha', 'expires_at', 'advisory_ids'], [], 'owner disposition');
  requireEvidence(value.status === 'ACCEPTED' && value.scope === 'contest-only', 'owner disposition: unsupported scope');
  requireEvidence(id(value.project, 'disposition project') === expected.project && sha(value.sha, 'disposition commit') === expected.sha, 'owner disposition identity mismatch');
  const expires = timestamp(value.expires_at, 'disposition expiry');
  const advisories = strings(value.advisory_ids, 'disposition advisories');
  const observed = [...new Set(findings.flatMap(row => row.advisory_ids ?? []))];
  requireEvidence(advisories.length > 0 && advisories.every(advisory => observed.includes(advisory)), 'owner disposition advisory mismatch');
  return {status: Date.parse(expires) >= Date.parse(expected.reviewed_at) ? 'RECORDED_ACCEPTANCE' : 'EXPIRED', scope: 'contest-only', expires_at: expires, advisory_ids: advisories, grants_release: false,
    authenticity: 'HUMAN_SUPPLIED_RECORD_NOT_AUTHENTICATED_BY_THIS_REPORT'};
}

function modelNote(value) {
  if (value === undefined) return null;
  exactKeys(value, ['text', 'source'], [], 'model note');
  exactKeys(value.source, ['kind', 'id', 'captured_at'], ['input_sha'], 'model provenance');
  requireEvidence(value.source.kind === 'historical-interpretation', 'model note cannot supply current approval');
  return {text: text(value.text, 'model text'), source: {kind: 'historical-interpretation', id: id(value.source.id, 'model session'),
    captured_at: timestamp(value.source.captured_at, 'model capture time'), input_sha: value.source.input_sha === undefined ? null : sha(value.source.input_sha, 'model input commit')}, authority: 'INTERPRETATION_ONLY'};
}

export function generateReview(packet, trustedExpectation) {
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
    consistency: 'PASSED', provenance_status: hasNativeBytes ? 'NATIVE_BYTES_DECLARED' : 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE',
    provenance_limit: 'Byte integrity and packet consistency only; this report does not authenticate the provider or the collecting actor.',
    command_execution: {status: 'SUCCEEDED', application_exits: validation.data}, jobs: native.jobs, scan_coverage: 'COMPLETE',
    findings: result.results, qc_verdict: nativeVerdict === 'failed' ? 'FAILED_WITH_FINDINGS' : 'NO_FINDINGS_IN_SUPPLIED_COVERAGE',
    native_pipeline_status: native.pipeline_status, artifacts: receipts, historical_unknowns: result.historical_unknowns,
    owner_risk_disposition: disposition(expected.owner_disposition, expected, result.results),
    human_release: {status: 'PENDING', approved: false, authority: 'SEPARATE_HUMAN_DECISION_REQUIRED'},
    deployment: {authorized: false, action: 'NONE'}, model_note: modelNote(packet.model)};
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

export function renderHtml(report) {
  requireEvidence(record(report) && report.contract === REPORT_VERSION && report.human_release?.approved === false && report.deployment?.authorized === false, 'invalid review output');
  const e = escapeHtml;
  const cards = [['QC verdict', report.qc_verdict], ['Evidence consistency', report.consistency], ['Artifact provenance', report.provenance_status], ['Human release', report.human_release.status]];
  const jobs = report.jobs.map(job => `<tr><td>${e(job.name)}</td><td>${e(job.id)}</td><td>${e(job.status)}</td></tr>`).join('');
  const findings = report.findings.map(row => `<tr><td>${e(row.name)}</td><td>${e(row.execution)}</td><td>${e(row.coverage)}</td><td>${e(row.findings_count)}</td><td>${e((row.advisory_ids ?? row.records).join(', ') || 'None reported')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ChangeGate · Release review</title>
<style>body{margin:0;background:#f3f5f8;color:#182330;font:16px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:40px 24px}h1{margin:0;font-size:34px;letter-spacing:-.8px}h2{font-size:20px;margin:28px 0 12px}.eyebrow{font-weight:700;color:#405a78;letter-spacing:1px;font-size:12px}.muted{color:#526174}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:24px 0}.card,section{background:white;border:1px solid #d9e0e8;border-radius:12px;padding:18px}.card small{display:block;color:#526174;margin-bottom:8px}.card strong{display:block;font-size:14px;overflow-wrap:anywhere}.warning{border-left:5px solid #b56112;padding:14px 18px;background:#fff5e7;border-radius:6px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e2e7ed}code{font-size:13px;overflow-wrap:anywhere}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.note{white-space:pre-wrap}footer{margin-top:24px;font-size:12px;color:#526174}</style></head>
<body><main><div class="eyebrow">CHANGEGATE RELEASEPROOF</div><h1>Release review</h1><p class="muted">Project ${e(report.expected.project)} · Pipeline ${e(report.expected.pipeline)}<br>Commit <code>${e(report.expected.sha)}</code> · Review time ${e(report.expected.reviewed_at)}</p>
<div class="warning"><strong>Human release approval is pending.</strong> This report supplies evidence for review. It performs no deployment and grants no release authority.</div>
<div class="cards">${cards.map(([label, value]) => `<div class="card"><small>${e(label)}</small><strong>${e(value)}</strong></div>`).join('')}</div>
<h2>Required jobs</h2><section class="table"><table><thead><tr><th>Job</th><th>ID</th><th>Native status</th></tr></thead><tbody>${jobs}</tbody></table></section>
<h2>Execution, coverage and findings</h2><section class="table"><table><thead><tr><th>Check</th><th>Execution</th><th>Coverage</th><th>Records</th><th>Advisory / finding IDs</th></tr></thead><tbody>${findings}</tbody></table></section>
<h2>Risk disposition</h2><section><strong>${e(report.owner_risk_disposition.status)}</strong><p class="muted">A recorded risk acceptance does not change the QC verdict or grant release approval.</p></section>
<h2>Historical unknowns</h2><section><ul>${report.historical_unknowns.map(unknown => `<li>${e(unknown)}</li>`).join('')}</ul></section>
${report.model_note ? `<h2>Historical model interpretation</h2><section><p class="muted">Session ${e(report.model_note.source.id)} · ${e(report.model_note.source.captured_at)} · Interpretation only</p><div class="note">${e(report.model_note.text)}</div></section>` : ''}
<h2>Receipt and byte-integrity details</h2><section><p class="muted">${e(report.provenance_limit)}</p><pre>${e(canonicalJson({artifacts: report.artifacts, human_release: report.human_release, deployment: report.deployment}))}</pre></section>
<footer>${e(REPORT_VERSION)} · Offline, deterministic report · No scripts or external resources</footer></main></body></html>\n`;
}
