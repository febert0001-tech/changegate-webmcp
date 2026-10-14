import fs from 'node:fs';
import path from 'node:path';
import {generateReview, canonicalJson, renderHtml, EvidenceError} from './report.mjs';

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
      try {
        while (length < bytes.length) {
          const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      if (length > maxBytes) throw new EvidenceError(`${label}: input too large`);
      try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
      catch { throw new EvidenceError(`${label}: malformed JSON`); }
    };
    const expected = read(options.get('--expected'), 32_768, 'expectation');
    const packet = read(options.get('--packet'), 1_048_576, 'packet');
    const output = path.resolve(options.get('--out'));
    for (const filename of [options.get('--expected'), options.get('--packet')]) {
      if (['review.json', 'review.html'].some(name => path.resolve(filename) === path.join(output, name))) throw new EvidenceError('output must not overwrite an input');
    }
    const report = generateReview(packet, expected);
    const json = canonicalJson(report);
    const html = renderHtml(report);
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, 'review.json'), json);
    fs.writeFileSync(path.join(output, 'review.html'), html);
    console.log(`Report generated: ${report.qc_verdict}; ${report.provenance_status}; human release PENDING.`);
  }
} catch (error) {
  // Never print input contents, native receipt bodies or credential-bearing paths.
  console.error(error instanceof EvidenceError ? error.message : 'Report generation failed; inspect the trusted local inputs and output directory.');
  process.exitCode = 2;
}
