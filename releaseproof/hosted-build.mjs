import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runDemo} from './demo.mjs';
import {DEMO_FILES, observeDemoFiles} from './demo-page.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const files = [...DEMO_FILES, 'index.html'];

// Own only these three named directories. No caller-supplied output path, raw
// artifact directory copy, provider access, or runtime web execution is supported.
export function generateHostedBundle({root = repository, run = runDemo, env = process.env} = {}) {
  const publicRoot = path.join(root, 'public');
  const workRoot = path.join(root, 'work');
  for (const parent of [root, publicRoot, workRoot]) {
    if (fs.existsSync(parent)) assert.ok(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), 'Hosted bundle parent must be a real directory');
    else fs.mkdirSync(parent);
  }
  const published = path.join(publicRoot, 'releaseproof-demo');
  const attempt = path.join(workRoot, 'releaseproof-hosted-demo');
  const staging = path.join(workRoot, 'releaseproof-hosted-publication');
  // Remove stale publicly served evidence before attempting fresh generation.
  fs.rmSync(published, {recursive: true, force: true});
  fs.rmSync(staging, {recursive: true, force: true});
  fs.rmSync(attempt, {recursive: true, force: true});
  try {
    const receipt = run(attempt, {env});
    assert.equal(receipt.outcome, 'SYNTHETIC_DEMONSTRATION_PASSED');
    assert.ok(!receipt.failure);
    const available = observeDemoFiles(attempt);
    for (const name of DEMO_FILES) assert.ok(available.has(name), `Missing hosted demo asset: ${name}`);
    assert.ok(fs.lstatSync(path.join(attempt, 'index.html')).isFile() && !fs.lstatSync(path.join(attempt, 'index.html')).isSymbolicLink(), 'Missing hosted entry page');
    // Explicit allowlist: never publish unrelated or private files from work/.
    fs.mkdirSync(staging);
    for (const name of files) {
      const destination = path.join(staging, name);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(path.join(attempt, name), destination, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(staging, published);
    return receipt;
  } catch (error) {
    fs.rmSync(staging, {recursive: true, force: true});
    fs.rmSync(published, {recursive: true, force: true});
    // The original attempt and its receipt/logs stay in work/ for Actions retention.
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { generateHostedBundle(); }
  catch (error) { console.error(`Hosted SYNTHETIC bundle generation failed: ${error.message}`); process.exitCode = 1; }
}
