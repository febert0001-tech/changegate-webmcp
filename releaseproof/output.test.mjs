import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fixture} from './fixtures.mjs';
import {generateReview, canonicalJson, renderHtml} from './report.mjs';

// GitHub-only child probe: observe exclusive creation and descriptor cleanup,
// inject publication failures, and forbid opening/truncating destination files.
function installProbe() {
  const directory = process.env.RELEASEPROOF_SAFE_DIRECTORY;
  const expected = process.env.RELEASEPROOF_SAFE_EXPECTED;
  const receipt = process.env.RELEASEPROOF_SAFE_RECEIPT;
  const mode = process.env.RELEASEPROOF_SAFE_MODE;
  const json = path.join(directory, 'review.json');
  const html = path.join(directory, 'review.html');
  const originals = {
    open: fs.openSync, write: fs.writeFileSync, close: fs.closeSync,
    sync: fs.fsyncSync, rename: fs.renameSync, unlink: fs.unlinkSync, link: fs.linkSync,
  };
  const descriptors = new Map();
  const state = {createAttempts: 0, created: [], closed: 0, writes: 0, syncs: 0, renames: 0,
    destinationOpens: 0, truncations: 0, modes: [], collision: null};
  fs.openSync = function(filename, flags, ...args) {
    if ([json, html].includes(String(filename))) {
      state.destinationOpens++;
      throw new Error('synthetic forbidden destination open');
    }
    if (flags !== 'wx') return originals.open.call(this, filename, flags, ...args);
    state.createAttempts++;
    if (mode === 'open-second' && state.createAttempts === 2) throw new Error('synthetic temporary open failure');
    if (mode === 'collision-second' && state.createAttempts === 2) {
      originals.write(filename, 'synthetic collision bytes\n');
      state.collision = String(filename);
    }
    const descriptor = originals.open.call(this, filename, flags, ...args);
    descriptors.set(descriptor, String(filename));
    state.created.push(String(filename));
    state.modes.push(args[0]);
    return descriptor;
  };
  fs.writeFileSync = function(destination, ...args) {
    if (descriptors.has(destination)) {
      state.writes++;
      if ((mode === 'write-first' && state.writes === 1) || (mode === 'write-second' && state.writes === 2)) {
        throw new Error('synthetic temporary write failure');
      }
    }
    return originals.write.call(this, destination, ...args);
  };
  fs.fsyncSync = function(descriptor) {
    const result = originals.sync.call(this, descriptor);
    if (descriptors.has(descriptor)) {
      state.syncs++;
      if (mode === 'sync-second' && state.syncs === 2) throw new Error('synthetic temporary flush failure');
      if (state.syncs === 2 && ['late-input-alias', 'late-output-alias'].includes(mode)) {
        originals.unlink(html);
        originals.link(mode === 'late-input-alias' ? expected : json, html);
      }
    }
    return result;
  };
  fs.closeSync = function(descriptor) {
    const result = originals.close.call(this, descriptor);
    if (descriptors.delete(descriptor)) state.closed++;
    return result;
  };
  fs.ftruncateSync = function() {
    state.truncations++;
    throw new Error('synthetic forbidden truncation');
  };
  fs.renameSync = function(source, destination) {
    state.renames++;
    if ((mode === 'rename-first' && state.renames === 1) || (mode === 'rename-second' && state.renames === 2)) {
      throw new Error('synthetic atomic rename failure');
    }
    return originals.rename.call(this, source, destination);
  };
  process.once('exit', () => originals.write(receipt, JSON.stringify({...state, openDescriptors: descriptors.size})));
}

function runOutputCase({mode = 'normal', setup = () => {}}, check) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'releaseproof-safe-output-'));
  try {
    const source = fixture();
    const expected = path.join(directory, 'expected.json');
    const packet = path.join(directory, 'packet.json');
    fs.writeFileSync(expected, JSON.stringify(source.expected));
    fs.writeFileSync(packet, JSON.stringify(source.packet));
    const inputBytes = [fs.readFileSync(expected), fs.readFileSync(packet)];
    const output = path.join(directory, 'output');
    fs.mkdirSync(output);
    const json = path.join(output, 'review.json');
    const html = path.join(output, 'review.html');
    const previous = {json: 'synthetic old JSON output\n', html: 'synthetic old HTML output\n'};
    fs.writeFileSync(json, previous.json);
    fs.writeFileSync(html, previous.html);
    const extra = setup({directory, output, json, html, expected, packet});
    const preload = path.join(directory, 'probe.mjs');
    fs.writeFileSync(preload, "import fs from 'node:fs'; import path from 'node:path';\n(" + installProbe.toString() + ")();\n");
    const receipt = path.join(directory, 'publication-receipt.json');
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli,
      '--expected', expected, '--packet', packet, '--out', output], {
      encoding: 'utf8', timeout: 10_000, env: {...process.env,
        RELEASEPROOF_SAFE_DIRECTORY: output, RELEASEPROOF_SAFE_EXPECTED: expected,
        RELEASEPROOF_SAFE_RECEIPT: receipt, RELEASEPROOF_SAFE_MODE: mode},
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const observation = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(observation.destinationOpens, 0, 'never open a destination file for writing');
    assert.equal(observation.truncations, 0, 'never truncate a destination inode');
    assert.equal(observation.openDescriptors, 0);
    assert.equal(observation.closed, observation.created.length);
    for (const permissions of observation.modes) assert.equal(permissions, 0o600);
    for (const filename of observation.created) assert.equal(fs.existsSync(filename), false, 'owned temporary names must be removed or published');
    const leftovers = fs.readdirSync(output).filter(name => name.startsWith('.releaseproof-')).sort();
    assert.deepEqual(leftovers, observation.collision ? [path.basename(observation.collision)] : []);
    assert.deepEqual(fs.readFileSync(expected), inputBytes[0]);
    assert.deepEqual(fs.readFileSync(packet), inputBytes[1]);
    check({result, output, json, html, source, previous, observation, extra});
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

function assertPublished({result, json, html, source, observation}) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = generateReview(source.packet, source.expected);
  assert.equal(fs.readFileSync(json, 'utf8'), canonicalJson(report));
  assert.equal(fs.readFileSync(html, 'utf8'), renderHtml(report));
  assert.equal(fs.lstatSync(json).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(html).isSymbolicLink(), false);
  assert.equal(fs.statSync(json).nlink, 1);
  assert.equal(fs.statSync(html).nlink, 1);
  assert.equal(observation.created.length, 2);
  assert.equal(observation.renames, 2);
  assert.match(result.stdout, /FAILED_WITH_FINDINGS; INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE; human release PENDING/);
}

for (const name of ['review.json', 'review.html']) {
  for (const alias of ['symlink', 'hard-link']) {
    test('atomic publication preserves unrelated ' + alias + ' target of ' + name, () => {
      runOutputCase({setup: ({directory, output}) => {
        const target = path.join(directory, 'synthetic-unrelated-target');
        const bytes = Buffer.from('synthetic unrelated target\n\u0000unchanged bytes');
        fs.writeFileSync(target, bytes);
        const destination = path.join(output, name);
        fs.unlinkSync(destination);
        if (alias === 'symlink') fs.symlinkSync(target, destination);
        else fs.linkSync(target, destination);
        return {target, bytes};
      }}, data => {
        assertPublished(data);
        assert.deepEqual(fs.readFileSync(data.extra.target), data.extra.bytes);
      });
    });
  }
}

test('exclusive staging atomically replaces ordinary reports and leaves no temporary files', () => {
  runOutputCase({}, assertPublished);
});

for (const mode of ['open-second', 'write-first', 'write-second', 'sync-second', 'rename-first', 'rename-second']) {
  test('owned temporary files and descriptors are cleaned on ' + mode + ' failure', () => {
    runOutputCase({mode}, ({result, json, html, source, previous, observation}) => {
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Report generation failed; inspect the trusted local inputs and output directory.\n');
      assert.equal(fs.readFileSync(html, 'utf8'), previous.html);
      assert.equal(fs.readFileSync(json, 'utf8'), mode === 'rename-second'
        ? canonicalJson(generateReview(source.packet, source.expected)) : previous.json);
      assert.ok(observation.created.length > 0);
    });
  });
}

test('input aliases introduced after staging are rejected and owned temporary files removed', () => {
  runOutputCase({mode: 'late-input-alias'}, ({result, json, html, previous, source}) => {
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'output must not overwrite an input\n');
    assert.equal(fs.readFileSync(json, 'utf8'), previous.json);
    assert.equal(fs.readFileSync(html, 'utf8'), JSON.stringify(source.expected));
  });
});

test('output aliases introduced after staging are rejected and owned temporary files removed', () => {
  runOutputCase({mode: 'late-output-alias'}, ({result, json, html, previous}) => {
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'output files must be distinct\n');
    assert.equal(fs.readFileSync(json, 'utf8'), previous.json);
    assert.equal(fs.readFileSync(html, 'utf8'), previous.json);
  });
});

test('exclusive-create collision preserves the unowned file and cleans the earlier owned temporary file', () => {
  runOutputCase({mode: 'collision-second'}, ({result, json, html, previous, observation}) => {
    assert.equal(result.status, 2);
    assert.equal(fs.readFileSync(json, 'utf8'), previous.json);
    assert.equal(fs.readFileSync(html, 'utf8'), previous.html);
    assert.equal(observation.created.length, 1);
    assert.equal(fs.readFileSync(observation.collision, 'utf8'), 'synthetic collision bytes\n');
  });
});
