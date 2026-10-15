// GitHub-only production browser smoke. Copied beside a runner-temporary pinned
// Playwright installation; no browser/dependency is added to the application.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const output = path.resolve('work/hosted-smoke');
fs.mkdirSync(output, {recursive: true});
const log = fs.openSync(path.join(output, 'server.log'), 'w');
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
  stdio: ['ignore', log, log], env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'},
});
const base = 'http://127.0.0.1:3100';
const result = {synthetic: true, outcome: 'FAILED', sha: process.env.GITHUB_SHA ?? null,
  run_id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, checks: []};
let browser;
try {
  let ready = false;
  for (let count = 0; count < 60; count++) {
    if (server.exitCode !== null) throw new Error(`Production server exited ${server.exitCode}`);
    try { ready = (await fetch(base)).ok; } catch { /* Wait for the production server. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Production server did not become ready');
  browser = await chromium.launch({headless: true});
  // A normal browser with JS disabled proves discovery requires neither WebMCP
  // nor a new client command surface. Existing refund authority tests run separately.
  const context = await browser.newContext({javaScriptEnabled: false, viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('link', {name: 'ReleaseProof synthetic demo', exact: true}).click();
  assert.equal(new URL(page.url()).pathname, '/releaseproof');
  assert.match(await page.locator('main').innerText(), /SYNTHETIC/);
  assert.match(await page.locator('main').innerText(), /not deployment recovery/);
  assert.ok(!(await page.locator('main').innerText()).includes('SYNTHETIC DEMONSTRATION COMPLETED'));
  result.checks.push('homepage discovery and /releaseproof without JavaScript or WebMCP');
  await page.getByRole('link', {name: 'Open retained synthetic walkthrough', exact: true}).click();
  assert.equal(new URL(page.url()).pathname, '/releaseproof-demo/index.html');
  assert.match(await page.locator('main').innerText(), /SYNTHETIC DEMONSTRATION COMPLETED/);
  assert.equal(await page.locator('script').count(), 0);
  const fixed = new Set(['receipt.json', 'WALKTHROUGH.md', 'valid-input/packet.json', 'valid-input/expected.json',
    'negative-packet.json', 'recovery-packet.json', 'producer.stdout', 'producer.stderr', 'negative.stdout', 'negative.stderr',
    'recovery.stdout', 'recovery.stderr', 'recovery-output/review.json', 'recovery-output/review.html']);
  const hrefs = await page.locator('a').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
  assert.equal(hrefs.length, fixed.size);
  for (const href of hrefs) {
    assert.ok(fixed.has(href), `Unexpected evidence destination ${href}`);
    const response = await context.request.get(`${base}/releaseproof-demo/${href}`);
    assert.equal(response.status(), 200, href);
    assert.match(response.headers()['content-security-policy'], /default-src 'none'/);
  }
  result.checks.push('all fixed evidence links return 200 with restrictive CSP');
  const receipt = await (await context.request.get(`${base}/releaseproof-demo/receipt.json`)).json();
  assert.equal(receipt.outcome, 'SYNTHETIC_DEMONSTRATION_PASSED');
  assert.equal(receipt.github.sha, process.env.GITHUB_SHA);
  assert.equal(receipt.github.run_id, process.env.GITHUB_RUN_ID);
  assert.equal(receipt.github.attempt, process.env.GITHUB_RUN_ATTEMPT);
  assert.deepEqual(receipt.attempts.map(item => item.exit_code), [0, 2, 0]);
  for (const item of receipt.attempts) { assert.equal(item.signal, null); assert.equal(item.spawn_error, null); }
  for (const [name, key] of [['valid-input/packet.json', 'valid'], ['valid-input/expected.json', 'expected'], ['negative-packet.json', 'negative'], ['recovery-packet.json', 'recovery']]) {
    const bytes = await (await context.request.get(`${base}/releaseproof-demo/${name}`)).body();
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.inputs[key].sha256);
    assert.equal(bytes.length, receipt.inputs[key].byte_count);
  }
  assert.equal(receipt.inputs.valid.sha256, receipt.inputs.recovery.sha256);
  assert.match(await (await context.request.get(`${base}/releaseproof-demo/negative.stderr`)).text(), /^packet: missing field\r?\n$/);
  result.checks.push('actual Actions identity, CLI exits, input digests and negative diagnostic');
  await page.screenshot({path: path.join(output, 'walkthrough-narrow.png'), fullPage: true});
  await page.getByRole('link', {name: 'recovery-output/review.html', exact: true}).click();
  const reportText = await page.locator('main').innerText();
  for (const marker of ['FAILED_WITH_FINDINGS', 'INCOMPLETE_NATIVE_ARTIFACT_PROVENANCE', 'High: 5', 'Human release approval is pending.']) assert.ok(reportText.includes(marker), marker);
  assert.equal(await page.locator('script').count(), 0);
  const report = await (await context.request.get(`${base}/releaseproof-demo/recovery-output/review.json`)).json();
  assert.equal(report.human_release.approved, false);
  assert.equal(report.deployment.authorized, false);
  result.checks.push('ordinary-browser recovery report retains failed findings and human authority limits');
  const absent = await context.request.get(`${base}/releaseproof-demo/not-retained.json`);
  assert.equal(absent.status(), 404);
  assert.ok(!(await absent.text()).includes('SYNTHETIC DEMONSTRATION COMPLETED'));
  result.checks.push('absent asset is 404 without a completion claim');
  result.outcome = 'SYNTHETIC_HOSTED_SMOKE_PASSED';
} catch (error) {
  result.failure = error.stack ?? error.message;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.closeSync(log);
}
