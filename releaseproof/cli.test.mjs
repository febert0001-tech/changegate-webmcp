import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {generateReview, canonicalJson, renderHtml} from './report.mjs';
import {fixture} from './fixtures.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const inputs = [
  {key: 'expected', label: 'expectation', limit: 32_768},
  {key: 'packet', label: 'packet', limit: 1_048_576},
];
const padBytes = (json, size) => json + ' '.repeat(size - Buffer.byteLength(json, 'utf8'));

// Runs only in the GitHub QC child. Observe actual reads, force short reads,
// and inject a read failure without adding a production test hook.
const probeSource = String.raw`
import fs from 'node:fs';
const target = process.env.RELEASEPROOF_PROBE_INPUT;
const receipt = process.env.RELEASEPROOF_PROBE_RECEIPT;
const mode = process.env.RELEASEPROOF_PROBE_MODE;
const originals = {open: fs.openSync, read: fs.readSync, close: fs.closeSync, whole: fs.readFileSync};
const state = {opened: 0, closed: 0, bytes: 0, requests: [], wholeReads: 0, errorInjected: false};
let tracked;
fs.openSync = function(filename, ...args) {
  const descriptor = originals.open.call(this, filename, ...args);
  if (String(filename) === target) { tracked = descriptor; state.opened++; }
  return descriptor;
};
fs.readSync = function(descriptor, buffer, offset, length, position) {
  if (descriptor !== tracked) return originals.read.call(this, descriptor, buffer, offset, length, position);
  state.requests.push({offset, length, position, before: state.bytes});
  if (mode === 'read-error' && state.requests.length === 2) {
    state.errorInjected = true;
    throw new Error('synthetic read failure');
  }
  const count = originals.read.call(this, descriptor, buffer, offset, Math.min(length, 4096), position);
  state.bytes += count;
  return count;
};
fs.closeSync = function(descriptor) {
  const result = originals.close.call(this, descriptor);
  if (descriptor === tracked) { state.closed++; tracked = undefined; }
  return result;
};
fs.readFileSync = function(filename, ...args) {
  if (String(filename) === target) {
    state.wholeReads++;
    throw new Error('unbounded input read attempted');
  }
  return originals.whole.call(this, filename, ...args);
};
process.once('exit', () => fs.writeFileSync(receipt, JSON.stringify(state)));
`;

function runCase({key, raw, probeMode}, check) {
  const directory = mkdtempSync(path.join(tmpdir(), 'releaseproof-bounded-cli-'));
  try {
    const source = fixture();
    const paths = {expected: path.join(directory, 'expected.json'), packet: path.join(directory, 'packet.json')};
    for (const input of inputs) {
      writeFileSync(paths[input.key], input.key === key ? raw : JSON.stringify(source[input.key]));
    }
    const output = path.join(directory, 'output');
    const args = [];
    const env = {...process.env};
    const receipt = path.join(directory, 'read-receipt.json');
    if (probeMode) {
      const preload = path.join(directory, 'probe.mjs');
      writeFileSync(preload, probeSource);
      args.push('--import', pathToFileURL(preload).href);
      env.RELEASEPROOF_PROBE_INPUT = paths[key];
      env.RELEASEPROOF_PROBE_RECEIPT = receipt;
      env.RELEASEPROOF_PROBE_MODE = probeMode;
    }
    args.push(cli, '--expected', paths.expected, '--packet', paths.packet, '--out', output);
    const result = spawnSync(process.execPath, args, {encoding: 'utf8', env, timeout: 10_000});
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    check({result, output, source});
    if (probeMode) {
      const state = JSON.parse(readFileSync(receipt, 'utf8'));
      const {limit} = inputs.find(input => input.key === key);
      assert.equal(state.wholeReads, 0, 'must not read the entire input');
      assert.equal(state.opened, 1);
      assert.equal(state.closed, 1, 'close the input on every exit path');
      assert.ok(state.requests.length > 1, 'handle partial reads');
      assert.ok(state.bytes <= limit + 1);
      for (const request of state.requests) {
        assert.ok(request.length > 0 && request.length <= limit + 1 - request.before);
        assert.equal(request.offset, request.before);
      }
      if (probeMode === 'oversized') assert.equal(state.bytes, limit + 1);
      else if (probeMode === 'read-error') assert.equal(state.errorInjected, true);
      else assert.equal(state.bytes, Buffer.byteLength(raw, 'utf8'));
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

function assertReport({result, output, source}) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = generateReview(source.packet, source.expected);
  assert.equal(readFileSync(path.join(output, 'review.json'), 'utf8'), canonicalJson(report));
  assert.equal(readFileSync(path.join(output, 'review.html'), 'utf8'), renderHtml(report));
  assert.equal(result.stdout, 'Report generated: FAILED_WITH_FINDINGS; INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE; human release PENDING.\n');
}

const assertRejected = message => ({result, output}) => {
  assert.equal(result.status, 2);
  assert.equal(result.stderr, message + '\n');
  assert.equal(result.stdout, '');
  assert.equal(existsSync(output), false, 'rejected input must not create outputs');
};

for (const {key, label, limit} of inputs) {
  for (const delta of [-1, 0, 1]) {
    test(`CLI ${label}: ${limit + delta} bytes ${delta > 0 ? 'rejected' : 'accepted'}`, () => {
      const raw = padBytes(JSON.stringify(fixture()[key]), limit + delta);
      runCase({key, raw}, delta > 0 ? assertRejected(`${label}: input too large`) : assertReport);
    });
  }
  test(`CLI ${label}: oversized multibyte JSON is measured in bytes`, () => {
    const raw = padBytes(JSON.stringify({synthetic: 'é'.repeat(Math.floor(limit / 2) - 32)}), limit + 1);
    assert.ok(raw.length < limit);
    runCase({key, raw}, assertRejected(`${label}: input too large`));
  });
  for (const mode of ['valid', 'oversized', 'malformed', 'read-error']) {
    test(`CLI ${label}: bounded short reads and descriptor cleanup for ${mode}`, () => {
      let raw;
      let check;
      if (mode === 'valid') {
        raw = padBytes(JSON.stringify(fixture()[key]), limit);
        check = assertReport;
      } else if (mode === 'oversized') {
        // Malformed and far larger than the bound: reject size before parsing.
        raw = '{' + 'x'.repeat(limit * 4);
        check = assertRejected(`${label}: input too large`);
      } else if (mode === 'malformed') {
        raw = '{' + ' '.repeat(8192);
        check = assertRejected(`${label}: malformed JSON`);
      } else {
        raw = padBytes(JSON.stringify(fixture()[key]), limit);
        check = assertRejected('Report generation failed; inspect the trusted local inputs and output directory.');
      }
      runCase({key, raw, probeMode: mode}, check);
    });
  }
}
