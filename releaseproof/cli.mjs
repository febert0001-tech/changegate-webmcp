import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {generateReview, canonicalJson, renderHtml, EvidenceError, parseJson} from './report.mjs';

const usage = 'Usage: node releaseproof/cli.mjs --expected trusted-expectation.json --packet evidence-packet.json --out review-output';
try {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    console.log(usage);
  } else {
    if (argumentsList.length !== 6) throw new EvidenceError(usage);
    const options = new Map();
    for (let index = 0; index < argumentsList.length; index += 2) {
      const name = argumentsList[index];
      if (!['--expected', '--packet', '--out'].includes(name) || options.has(name) || !argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) throw new EvidenceError(usage);
      options.set(name, argumentsList[index + 1]);
    }
    const read = (filename, maxBytes, label) => {
      const bytes = Buffer.alloc(maxBytes + 1);
      const descriptor = fs.openSync(filename, 'r');
      let length = 0;
      let identity;
      try {
        identity = fs.fstatSync(descriptor, {bigint: true});
        while (length < bytes.length) {
          const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      if (length > maxBytes) throw new EvidenceError(`${label}: input too large`);
      return {value: parseJson(bytes.subarray(0, length).toString('utf8'), label), identity};
    };
    const expectedInput = read(options.get('--expected'), 32_768, 'expectation');
    const packetInput = read(options.get('--packet'), 1_048_576, 'packet');
    const expected = expectedInput.value;
    const packet = packetInput.value;
    const output = path.resolve(options.get('--out'));
    const outputs = ['review.json', 'review.html'].map(name => path.join(output, name));
    const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
    const identities = [expectedInput.identity, packetInput.identity];
    const protectInput = identity => {
      if (identities.some(input => sameFile(input, identity))) throw new EvidenceError('output must not overwrite an input');
    };
    for (const filename of [options.get('--expected'), options.get('--packet')]) {
      if (outputs.includes(path.resolve(filename))) throw new EvidenceError('output must not overwrite an input');
    }
    const protectDestinations = filenames => {
      // Read-only identity checks preserve the input and output-alias contract.
      // Publishing never opens these destination paths for writing.
      const existing = filenames.map(filename => {
        let identity;
        try { identity = fs.statSync(filename, {bigint: true}); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (identity) protectInput(identity);
        return identity;
      });
      if (existing.every(Boolean) && sameFile(existing[0], existing[1])) throw new EvidenceError('output files must be distinct');
    };
    protectDestinations(outputs);
    const report = generateReview(packet, expected);
    const json = canonicalJson(report);
    const html = renderHtml(report);
    fs.mkdirSync(output, {recursive: true});
    // The caller must trust this directory and its ancestors against concurrent
    // replacement. Same-directory renames replace links, never their targets.
    const trustedDirectory = fs.realpathSync(output);
    const destinations = ['review.json', 'review.html'].map(name => path.join(trustedDirectory, name));
    const temporary = new Set();
    const stage = (name, content) => {
      const filename = path.join(trustedDirectory, `.releaseproof-${randomUUID()}-${name}.tmp`);
      const descriptor = fs.openSync(filename, 'wx', 0o600);
      // Track only files this invocation exclusively created.
      temporary.add(filename);
      try {
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return filename;
    };
    try {
      const stagedJson = stage('review.json', json);
      const stagedHtml = stage('review.html', html);
      protectDestinations(destinations);
      fs.renameSync(stagedJson, destinations[0]);
      temporary.delete(stagedJson);
      fs.renameSync(stagedHtml, destinations[1]);
      temporary.delete(stagedHtml);
    } finally {
      let cleanupError;
      for (const filename of temporary) {
        try { fs.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
      }
      if (cleanupError) throw cleanupError;
    }
    console.log(`Report generated: ${report.qc_verdict}; ${report.provenance_status}; human release PENDING.`);
  }
} catch (error) {
  // Never print input contents, native receipt bodies or credential-bearing paths.
  console.error(error instanceof EvidenceError ? error.message : 'Report generation failed; inspect the trusted local inputs and output directory.');
  process.exitCode = 2;
}
