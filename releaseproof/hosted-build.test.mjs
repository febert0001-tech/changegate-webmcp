import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runDemo} from './demo.mjs';
import {generateHostedBundle} from './hosted-build.mjs';
import {DEMO_FILES} from './demo-page.mjs';

const temporary = t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-hosted-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'public'));
  return root;
};
const published = root => path.join(root, 'public/releaseproof-demo');

test('hosted generation reuses real demo, publishes only fixed files and preserves unrelated public assets', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'public/unrelated.txt'), 'keep');
  fs.mkdirSync(published(root));
  fs.writeFileSync(path.join(published(root), 'stale.txt'), 'old');
  const receipt = generateHostedBundle({root, env: {}, run: (directory, options) => {
    const result = runDemo(directory, options);
    fs.writeFileSync(path.join(directory, 'unrelated-secret.txt'), 'not for publication');
    return result;
  }});
  assert.equal(receipt.outcome, 'SYNTHETIC_DEMONSTRATION_PASSED');
  assert.deepEqual(receipt.attempts.map(item => item.exit_code), [0, 2, 0]);
  assert.equal(receipt.github, null);
  for (const name of [...DEMO_FILES, 'index.html']) assert.ok(fs.statSync(path.join(published(root), name)).isFile());
  assert.equal(fs.existsSync(path.join(published(root), 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(published(root), 'unrelated-secret.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'public/unrelated.txt'), 'utf8'), 'keep');
  assert.match(fs.readFileSync(path.join(published(root), 'index.html'), 'utf8'), /SYNTHETIC DEMONSTRATION COMPLETED/);
});

test('same fixed inputs and execution identity produce reproducible hosted bundle bytes', t => {
  const root = temporary(t);
  generateHostedBundle({root, env: {}});
  const before = Object.fromEntries([...DEMO_FILES, 'index.html'].map(name => [name, fs.readFileSync(path.join(published(root), name))]));
  generateHostedBundle({root, env: {}});
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(published(root), name)), bytes, name);
});

test('failed real demo removes stale public evidence and retains partial attempt without publishing success', t => {
  const root = temporary(t);
  generateHostedBundle({root, env: {}});
  assert.throws(() => generateHostedBundle({root, env: {}, run: (directory, options) => runDemo(directory, {
    ...options, spawn: () => ({status: null, signal: null, error: {code: 'ENOENT'}}),
  })}), /Demo process failure/);
  assert.equal(fs.existsSync(published(root)), false);
  const attempt = path.join(root, 'work/releaseproof-hosted-demo');
  assert.equal(JSON.parse(fs.readFileSync(path.join(attempt, 'receipt.json'))).outcome, 'FAILED');
  assert.match(fs.readFileSync(path.join(attempt, 'index.html'), 'utf8'), /FAILED \/ INCOMPLETE/);
});

for (const missing of ['receipt.json', 'negative.stderr', 'recovery-output/review.html', 'index.html']) {
  test(`incomplete assets abort hosted publication: ${missing}`, t => {
    const root = temporary(t);
    assert.throws(() => generateHostedBundle({root, env: {}, run: (directory, options) => {
      const result = runDemo(directory, options);
      fs.unlinkSync(path.join(directory, missing));
      return result;
    }}));
    assert.equal(fs.existsSync(published(root)), false);
    assert.ok(fs.existsSync(path.join(root, 'work/releaseproof-hosted-demo')));
  });
}

test('symlinked public parent is rejected without deleting unrelated external contents', t => {
  const root = temporary(t);
  fs.rmdirSync(path.join(root, 'public'));
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
  fs.symlinkSync(elsewhere, path.join(root, 'public'));
  assert.throws(() => generateHostedBundle({root, env: {}}), /real directory/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
});
