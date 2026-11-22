// Run from the repository root with playwright-core and a local Chrome binary.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright-core");

async function main() {
  const url = pathToFileURL(resolve("public/refund-review.html")).href;
  const folder = await mkdtemp(join(tmpdir(), "changegate-acceptance-"));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
    headless: true,
  });
  try {
    const first = await browser.newContext({ offline: true });
    const desk = await first.newPage();
    await desk.goto(url);
    await desk.getByLabel("Case reference").fill("acceptance-001");
    await desk.getByLabel("Review owner").fill("First shift");
    await desk.getByLabel("Finding and next action").fill("Check processor evidence");
    await desk.getByRole("button", { name: "Record update" }).click();
    const pendingDownload = desk.waitForEvent("download");
    await desk.getByRole("button", { name: "Download case" }).click();
    const saved = await pendingDownload;
    const handoff = join(folder, saved.suggestedFilename());
    await saved.saveAs(handoff);
    assert.equal(JSON.parse(await readFile(handoff, "utf8")).entries.length, 1);
    await first.close();

    const next = await browser.newContext({ offline: true });
    const reopened = await next.newPage();
    await reopened.goto(url);
    await reopened.getByLabel("Reopen saved case").setInputFiles(handoff);
    await reopened.getByText("Case reopened.", { exact: false }).waitFor();
    assert.equal(await reopened.getByLabel("Case reference").inputValue(), "acceptance-001");
    await reopened.getByLabel("Review owner").fill("Second shift");
    await reopened.getByLabel("Case status").selectOption("Resolved");
    await reopened.getByLabel("Finding and next action").fill("Compared both records");
    await reopened.getByRole("button", { name: "Record update" }).click();
    const history = await reopened.locator("#history li").allTextContents();
    assert.equal(history.length, 2);
    assert.match(history[0], /First shift/);
    assert.match(history[1], /Second shift · Resolved/);
    console.log("PASS: Offline Chrome case creation, downloaded file, fresh-session import and second-shift resolution.");
  } finally {
    await browser.close();
    await rm(folder, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
