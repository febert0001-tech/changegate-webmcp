import {digest, JOB_NAMES} from './report.mjs';

// Synthetic contract examples only. No private provider receipt is published.
export function fixture({sourceKind = 'synthetic-fixture', findings = true} = {}) {
  const expected = {contract: 'releaseproof-expectation/v1', project: '42', sha: 'a'.repeat(40), pipeline: '77',
    jobs: Object.fromEntries(JOB_NAMES.map((name, index) => [name, String(101 + index)])), reviewed_at: '2026-10-14T20:00:00Z'};
  const count = findings ? 5 : 0;
  const scan = name => ({execution: {status: 'SUCCEEDED', job: expected.jobs[name], exit: 0}, coverage: {status: 'COMPLETE', issues: []}, findings: {status: 'KNOWN', count: 0, ids: []}});
  const audit = number => ({execution: {status: 'SUCCEEDED', job: expected.jobs['npm-dependency-audit'], exit: 0}, coverage: {status: 'COMPLETE', issues: []},
    snapshot: {lockfile_sha256: 'd'.repeat(64), advisory_snapshot_sha256: 'e'.repeat(64)},
    findings: {status: 'KNOWN', count: number, records: Array.from({length: number}, (_, index) => `synthetic-package-${index + 1}`), advisory_ids: number ? ['GHSA-example-synthetic'] : [],
      severity_counts: {info: 0, low: 0, moderate: 0, high: number, critical: 0, total: number}}, command_exit: number ? 1 : 0});
  const summary = {project: expected.project, sha: expected.sha, pipeline: expected.pipeline,
    results: {sast: scan('semgrep-sast'), secrets: scan('secret_detection'), dependencies_full: audit(count), dependencies_production: audit(0)},
    coverage_complete: true, findings_present: findings, status: findings ? 'FINDINGS' : 'NO_FINDINGS_IN_REPORTED_COVERAGE', historical_audit_waiver: false,
    historical_unknowns: ['diagnostic_artifact_capture_time', 'lifecycle_approval_configuration_comparison'], g0: 'OPEN / NOT APPROVED', g1: 'CLOSED'};
  const pipeline = {id: 77, project_id: 42, sha: expected.sha, status: findings ? 'failed' : 'success'};
  const packet = {contract: 'releaseproof-packet/v1', native: {project: {id: 42}, commit: {id: expected.sha}, pipeline,
    jobs: JOB_NAMES.map(name => ({id: Number(expected.jobs[name]), name, status: name === 'qc-assessment' ? pipeline.status : 'success', commit: {id: expected.sha}, pipeline: {...pipeline}}))},
    qc_summary_raw: JSON.stringify(summary), validation_exits_raw: JSON.stringify({assessor: 0, tests: 0, typecheck: 0, lint: 0, build: 0}), provenance: {}};
  const provenance = (raw, name, file) => ({source_kind: sourceKind, project: expected.project, sha: expected.sha, pipeline: expected.pipeline, job: expected.jobs[name], path: file, sha256: digest(raw), byte_count: Buffer.byteLength(raw, 'utf8')});
  packet.provenance.qc_summary = provenance(packet.qc_summary_raw, 'qc-assessment', 'qc-summary.json');
  packet.provenance.validation_exits = provenance(packet.validation_exits_raw, 'application-validation', 'qc-validation/exits.json');
  return {expected, packet};
}

export function replaceSummary(packet, change) {
  const summary = JSON.parse(packet.qc_summary_raw);
  change(summary);
  packet.qc_summary_raw = JSON.stringify(summary);
  packet.provenance.qc_summary.sha256 = digest(packet.qc_summary_raw);
  packet.provenance.qc_summary.byte_count = Buffer.byteLength(packet.qc_summary_raw, 'utf8');
}

export function modelFixture() {
  return {text: 'Historical interpretation: findings remain visible; human review is required.', source: {kind: 'historical-interpretation', id: '9', captured_at: '2026-10-13T20:00:00Z', input_sha: 'b'.repeat(40)}};
}
