// Native PUBLIC dependency evidence; deliberately separate from synthetic demos.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function classifyAudit(result) {
  if (result.error || result.signal !== null || ![0, 1].includes(result.status)) return {outcome: 'COMMAND_FAILURE'};
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(result.stdout)); }
  catch { return {outcome: 'MALFORMED_EVIDENCE'}; }
  const counts = report?.metadata?.vulnerabilities;
  if (!object(report) || Object.hasOwn(report, 'error') || report.auditReportVersion !== 2 || !object(report.vulnerabilities) || !object(counts) ||
    ![...severities, 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
    severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
    Object.keys(report.vulnerabilities).length !== counts.total ||
    Object.entries(report.vulnerabilities).some(([name, item]) => !object(item) || item.name !== name || !severities.includes(item.severity) || !Array.isArray(item.via)) ||
    result.status !== (counts.total > 0 ? 1 : 0)) return {outcome: 'MALFORMED_EVIDENCE'};
  const tally = Object.fromEntries(severities.map(severity => [severity, 0]));
  for (const item of Object.values(report.vulnerabilities)) tally[item.severity]++;
  if (severities.some(severity => tally[severity] !== counts[severity])) return {outcome: 'MALFORMED_EVIDENCE'};
  return {outcome: counts.total > 0 ? 'COMPLETED_WITH_FINDINGS' : 'COMPLETED_NO_FINDINGS', counts};
}

export function collectDependencyAudit() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Dependency QC is permitted only in GitHub Actions');
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) if (!process.env[key]) throw new Error(`Missing Actions identity ${key}`);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = path.join(root, 'work/dependency-audit');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.mkdirSync(output); // Never mix evidence from separate attempts.
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  const manifest = fs.readFileSync(path.join(root, 'package.json'));
  const receipt = {kind: 'native-public-dependency-audit', outcome: 'EVIDENCE_FAILURE',
    github: {repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT},
    lockfile_sha256: digest(lock), manifest_sha256: digest(manifest), node: process.version, started_at: new Date().toISOString(),
    advisory_snapshot: {status: 'NOT_ESTABLISHED', reason: 'Full and production audits make separate registry requests; one lockfile and invocation window do not prove an atomic identical advisory snapshot.'},
    release_approved: false, audits: []};
  const invoke = (name, args) => {
    const started_at = new Date().toISOString();
    const result = spawnSync('npm', args, {cwd: root, encoding: null, timeout: 120000, maxBuffer: 8 * 1024 * 1024});
    const stdout = result.stdout ?? Buffer.alloc(0);
    const stderr = result.stderr ?? Buffer.alloc(0);
    const stdoutName = name === 'npm-version' ? 'npm-version.stdout' : `${name}.json`;
    fs.writeFileSync(path.join(output, stdoutName), stdout, {flag: 'wx'});
    fs.writeFileSync(path.join(output, `${name}.stderr`), stderr, {flag: 'wx'});
    return {result, entry: {name, command: ['npm', ...args], started_at, finished_at: new Date().toISOString(),
      exit_code: result.status, signal: result.signal, spawn_error: result.error?.code ?? null,
      stdout: {path: stdoutName, sha256: digest(stdout), byte_count: stdout.length},
      stderr: {path: `${name}.stderr`, sha256: digest(stderr), byte_count: stderr.length}}};
  };
  try {
    const npm = invoke('npm-version', ['--version']);
    receipt.npm = {...npm.entry, version: npm.result.stdout?.toString('utf8').trim() ?? null};
    if (npm.result.error || npm.result.signal !== null || npm.result.status !== 0) throw new Error('npm version capture failed');
    for (const [name, scope] of [['full', '--include=dev'], ['production', '--omit=dev']]) {
      const {result, entry} = invoke(name, ['audit', '--json', '--package-lock-only', scope, '--audit-level=info', '--registry=https://registry.npmjs.org']);
      receipt.audits.push({...entry, ...classifyAudit(result)});
      // Native public audit output is also visible in the job log for inspection.
      console.log(`BEGIN NATIVE ${name.toUpperCase()} AUDIT JSON`);
      console.log((result.stdout ?? Buffer.alloc(0)).toString('utf8'));
      console.log(`END NATIVE ${name.toUpperCase()} AUDIT JSON`);
    }
    receipt.lockfile_after_sha256 = digest(fs.readFileSync(path.join(root, 'package-lock.json')));
    receipt.manifest_after_sha256 = digest(fs.readFileSync(path.join(root, 'package.json')));
    if (receipt.lockfile_after_sha256 !== receipt.lockfile_sha256 || receipt.manifest_after_sha256 !== receipt.manifest_sha256) throw new Error('Dependency inputs changed during capture');
    if (receipt.audits.every(item => item.outcome.startsWith('COMPLETED_'))) receipt.outcome = receipt.audits.some(item => item.outcome === 'COMPLETED_WITH_FINDINGS') ? 'COMPLETED_WITH_FINDINGS' : 'COMPLETED_NO_FINDINGS';
  } catch (error) { receipt.failure = error.message; }
  finally {
    receipt.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
    console.log('NATIVE AUDIT RECEIPT\n' + JSON.stringify(receipt, null, 2));
  }
  // A finding is a policy failure, not an execution failure or a waiver.
  return receipt.outcome === 'COMPLETED_NO_FINDINGS' ? 0 : receipt.outcome === 'COMPLETED_WITH_FINDINGS' ? 1 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = collectDependencyAudit(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
