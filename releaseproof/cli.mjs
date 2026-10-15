import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
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
      let decoded;
      try {
        decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, length));
      } catch {
        throw new EvidenceError(`${label}: invalid UTF-8`);
      }
      return {value: parseJson(decoded, label), identity};
    };
    const expectedInput = read(options.get('--expected'), 32_768, 'expectation');
    const packetInput = read(options.get('--packet'), 1_048_576, 'packet');
    const expected = expectedInput.value;
    const packet = packetInput.value;
    const output = path.resolve(options.get('--out'));
    const recoveryMarker = path.join(output, 'review-publication-error.json');
    try {
      fs.lstatSync(recoveryMarker);
      throw new EvidenceError('Report publication recovery required; inspect the output directory before retrying.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    const backups = new Map();
    const published = new Set();
    let retainBackups = false;
    let primaryFailure;
    const backup = (destination, index) => {
      let entry;
      try { entry = fs.lstatSync(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; else return; }
      const filename = path.join(trustedDirectory, `.releaseproof-${randomUUID()}-${path.basename(destination)}.rollback`);
      // Both operations create exclusively; never overwrite a colliding name,
      // open a destination for writing, or follow its link to modify a target.
      if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(destination, {encoding: 'buffer'}), filename);
      else if (entry.isFile()) fs.linkSync(destination, filename);
      else throw new EvidenceError('report output must be a file or symbolic link');
      backups.set(index, filename);
    };
    try {
      const staged = [stage('review.json', json), stage('review.html', html)];
      protectDestinations(destinations);
      destinations.forEach(backup);
      protectDestinations(destinations);
      try {
        for (const [index, filename] of staged.entries()) {
          fs.renameSync(filename, destinations[index]);
          published.add(index);
          temporary.delete(filename);
        }
      } catch (publicationError) {
        if (published.size > 0) {
          let rollbackFailed = false;
          // Restore both prior entries, including an originally absent output.
          // Renaming between hard links to the same inode can be a no-op, so
          // backup names remain tracked until cleanup even after a restore.
          for (const index of [1, 0]) {
            try {
              if (backups.has(index)) fs.renameSync(backups.get(index), destinations[index]);
              else if (published.has(index)) fs.unlinkSync(destinations[index]);
            } catch { rollbackFailed = true; }
          }
          if (rollbackFailed) {
            retainBackups = true;
            // Durable warning where writable; exclusive creation protects even
            // an input or unrelated link colliding with this reserved name.
            let descriptor;
            try {
              descriptor = fs.openSync(recoveryMarker, 'wx', 0o600);
              fs.writeFileSync(descriptor, JSON.stringify({status: 'ROLLBACK_INCOMPLETE',
                use_reports: false, backup_names: [...backups.values()].map(filename => path.basename(filename)),
                instruction: 'Do not use the report pair. Restore prior entries from retained rollback files, or remove incomplete reports, then remove this marker after repair.'}, null, 2) + '\n');
              fs.fsyncSync(descriptor);
            } catch { /* The stderr failure must survive even if the marker cannot be written. */ }
            finally {
              if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch { /* Preserve the rollback failure diagnostic. */ }
              }
            }
            throw new EvidenceError('Report publication failed; rollback incomplete. Do not use review.json/review.html. Preserve rollback files and inspect review-publication-error.json if present.');
          }
        }
        throw publicationError;
      }
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      let cleanupError;
      const owned = [...temporary, ...(retainBackups ? [] : backups.values())];
      for (const filename of owned) {
        try { fs.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
      }
      if (cleanupError) {
        if (!primaryFailure) throw cleanupError;
        console.error('Report cleanup incomplete; inspect retained output-directory files.');
      }
    }
    console.log(`Report generated: ${report.qc_verdict}; ${report.provenance_status}; human release PENDING.`);
  }
} catch (error) {
  // Never print input contents, native receipt bodies or credential-bearing paths.
  console.error(error instanceof EvidenceError ? error.message : 'Report generation failed; inspect the trusted local inputs and output directory.');
  process.exitCode = 2;
}
