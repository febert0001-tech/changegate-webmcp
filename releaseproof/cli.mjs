import fs from 'node:fs';
import path from 'node:path';
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
    // stat follows symlinks; device/inode identity also detects hard links.
    for (const filename of outputs) {
      let identity;
      try { identity = fs.statSync(filename, {bigint: true}); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (identity) protectInput(identity);
    }
    const report = generateReview(packet, expected);
    const json = canonicalJson(report);
    const html = renderHtml(report);
    fs.mkdirSync(output, {recursive: true});
    let jsonDescriptor;
    let htmlDescriptor;
    try {
      // Open without truncation, then recheck both actual destinations before
      // changing either file. This covers aliases changed after the preflight.
      jsonDescriptor = fs.openSync(outputs[0], fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o666);
      htmlDescriptor = fs.openSync(outputs[1], fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o666);
      const jsonIdentity = fs.fstatSync(jsonDescriptor, {bigint: true});
      const htmlIdentity = fs.fstatSync(htmlDescriptor, {bigint: true});
      protectInput(jsonIdentity);
      protectInput(htmlIdentity);
      if (sameFile(jsonIdentity, htmlIdentity)) throw new EvidenceError('output files must be distinct');
      fs.ftruncateSync(jsonDescriptor, 0);
      fs.writeFileSync(jsonDescriptor, json);
      fs.ftruncateSync(htmlDescriptor, 0);
      fs.writeFileSync(htmlDescriptor, html);
    } finally {
      try { if (htmlDescriptor !== undefined) fs.closeSync(htmlDescriptor); }
      finally { if (jsonDescriptor !== undefined) fs.closeSync(jsonDescriptor); }
    }
    console.log(`Report generated: ${report.qc_verdict}; ${report.provenance_status}; human release PENDING.`);
  }
} catch (error) {
  // Never print input contents, native receipt bodies or credential-bearing paths.
  console.error(error instanceof EvidenceError ? error.message : 'Report generation failed; inspect the trusted local inputs and output directory.');
  process.exitCode = 2;
}
