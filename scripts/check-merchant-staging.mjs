import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as upstream } from "node:http";
import { createServer, request as secureRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2] ?? "changegate-staging:test";
const host = "changegate-qa.up.railway.app";
const origin = "https://" + host;
const suffix = randomBytes(8).toString("hex");
const volume = "changegate-qa-" + suffix;
const first = volume + "-first";
const second = volume + "-second";
const temp = mkdtempSync(join(tmpdir(), "changegate-tls-"));

function docker(args, env = process.env) {
  return execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function remove(...args) {
  try { docker(args); } catch { /* A failed test can stop before the fixture exists. */ }
}

const passwords = new Map();
const accounts = [
  { username: "maya", name: "Maya Chen", merchantId: "harbor", merchantName: "Harbor Goods" },
  { username: "jordan", name: "Jordan Lee", merchantId: "harbor", merchantName: "Harbor Goods" },
  { username: "alex", name: "Alex Rivera", merchantId: "ridge", merchantName: "Ridge Market" },
].map(employee => {
  const salt = randomBytes(16);
  const password = randomBytes(24).toString("hex");
  passwords.set(employee.username, password);
  return { ...employee, salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") };
});
const env = { ...process.env, CHANGEGATE_TEAM_ORIGIN: origin, RAILWAY_VOLUME_MOUNT_PATH: "/data",
  CHANGEGATE_TEAM_ROSTER_JSON: JSON.stringify(accounts.slice(0, 1)),
  CHANGEGATE_TEAM_ACCEPTANCE_ROSTER_JSON: JSON.stringify(accounts.slice(1)) };
let backendPort = 0;
let edge;

async function start(name) {
  docker(["run", "-d", "--name", name, "--publish", "127.0.0.1::3000",
    "--mount", "type=volume,source=" + volume + ",target=/data",
    "--env", "CHANGEGATE_TEAM_ORIGIN", "--env", "RAILWAY_VOLUME_MOUNT_PATH", "--env", "CHANGEGATE_TEAM_ROSTER_JSON",
    "--env", "CHANGEGATE_TEAM_ACCEPTANCE_ROSTER_JSON", image], env);
  const mapping = docker(["port", name, "3000/tcp"]);
  backendPort = Number(mapping.split(":").at(-1));
  assert(backendPort > 0);
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await request("/api/merchant/health").catch(() => undefined);
    if (result?.status === 200) return;
    await delay(250);
  }
  throw Error("The staging container never became ready.");
}

let certificate;
let address;
function request(path, { cookie, version, command, forwarded, originOverride } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, ...(cookie && { Cookie: cookie }),
      ...(version && { "X-ChangeGate-Session": version }),
      ...(forwarded === false && { "X-QA-Disable-Forwarding": "1" }),
      ...(command && { Origin: originOverride ?? origin, "Content-Type": "application/json" }) };
    const req = secureRequest({ hostname: "127.0.0.1", servername: host, port: address.port, ca: certificate,
      method: command ? "POST" : "GET", path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end(command ? JSON.stringify(command) : undefined);
  });
}

async function send(command, session) {
  const result = await request("/api/merchant", { command, ...session });
  assert(result.status === 200 || result.status === 201, "Unexpected command HTTP status " + result.status);
  return JSON.parse(result.body);
}

async function signIn(index) {
  const { username } = accounts[index];
  const password = passwords.get(username);
  const result = await request("/api/merchant", { command: { action: "signIn", username, password } });
  assert.equal(result.status, 200);
  const rawCookie = result.headers["set-cookie"]?.[0];
  assert(Boolean(rawCookie?.startsWith("__Host-changegate_team_session=")), "Missing host-only staging cookie");
  assert(/; Secure/.test(rawCookie) && /; HttpOnly/.test(rawCookie) && /; SameSite=Strict/.test(rawCookie));
  const session = JSON.parse(result.body);
  assert.equal(session.username, username);
  return { cookie: rawCookie.split(";")[0], version: session.sessionVersion };
}

try {
  const key = join(temp, "key.pem");
  const cert = join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=" + host, "-addext", "subjectAltName=DNS:" + host, "-keyout", key, "-out", cert], { stdio: "ignore" });
  certificate = readFileSync(cert);
  edge = createServer({ key: readFileSync(key), cert: certificate }, (incoming, outgoing) => {
    const headers = { ...incoming.headers };
    const noForwarding = headers["x-qa-disable-forwarding"];
    delete headers["x-qa-disable-forwarding"];
    if (!noForwarding) {
      headers["x-forwarded-host"] = host;
      headers["x-forwarded-proto"] = "https";
      headers["x-real-ip"] = "127.0.0.2";
    }
    const target = upstream({ hostname: "127.0.0.1", port: backendPort, path: incoming.url,
      method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    target.on("error", () => { outgoing.writeHead(502).end(); });
    incoming.pipe(target);
  });
  await new Promise(resolve => edge.listen(0, "127.0.0.1", resolve));
  address = edge.address();
  const missingVolume = docker(["run", "--rm", "--entrypoint", "sh", image, "-c",
    "RAILWAY_VOLUME_MOUNT_PATH=/data node scripts/start-merchant-staging.mjs >/dev/null 2>&1; printf '%s' \"$?\""]);
  assert.equal(missingVolume, "1");
  docker(["volume", "create", volume]);
  await start(first);
  const entry = await request("/");
  assert.equal(entry.status, 307);
  assert.equal(entry.headers.location, "/merchant");
  const signInPage = await request("/merchant");
  assert.equal(signInPage.status, 200);
  assert.match(signInPage.headers["x-robots-tag"], /noindex/);
  assert.match(signInPage.headers["strict-transport-security"], /max-age=/);
  assert.equal((await request("/api/merchant", { command: { action: "session" }, forwarded: false })).status, 403);
  assert.equal((await request("/api/merchant", { command: { action: "session" }, originOverride: "https://other.example" })).status, 403);
  assert.equal((await request("/api/merchant", { command: { action: "list" } })).status, 401);

  const maya = await signIn(0);
  const jordan = await signIn(1);
  const { case: opened } = await send({ action: "create", reference: "STAGING-QA-REF-2468" }, maya);
  const { id } = opened;
  await send({ action: "record", id, revision: 1, finding: "Redacted processor entry matched.",
    nextAction: "Confirm the amount.", status: "Awaiting evidence" }, maya);
  await send({ action: "assign", id, revision: 2, assignee: "jordan" }, maya);
  const queue = await send({ action: "workspace" }, jordan);
  assert(queue.cases.some(row => row.id === id && row.assignee === queue.session.username));
  await send({ action: "note", id, revision: 3, note: "Redacted order record confirmed." }, jordan);
  const resolved = await send({ action: "resolve", id, revision: 4 }, jordan);
  assert.equal(resolved.case.status, "Resolved");
  assert.deepEqual(resolved.history.map(event => [event.actor, event.kind]), [
    ["Maya Chen", "Opened"], ["Maya Chen", "Recorded finding"], ["Maya Chen", "Assigned"],
    ["Jordan Lee", "Added note"], ["Jordan Lee", "Resolved"],
  ]);
  assert(resolved.history.every(event => Number.isFinite(Date.parse(event.occurredAt))));

  const text = readFileSync("tests/fixtures/TEST-only-refund-export.csv", "utf8");
  const importCommand = { action: "importCsv", text, mapping: { reference: 0, amount: 1, currency: 2, status: 3 } };
  const { batch } = await send(importCommand, maya);
  assert.equal(batch.summary.acceptedCount, 4);
  assert.equal(batch.rejections.length, 2);
  const finding = batch.findings.find(finding => finding.kind === "Repeated reference");
  assert(finding);
  assert.deepEqual(finding.rows.map(row => row.line), [2, 3]);
  const assign = { action: "assignFinding", id: finding.id, assignee: "jordan" };
  const linked = await send(assign, maya);
  assert.equal((await send(assign, maya)).case.id, linked.case.id);
  assert.equal((await send(importCommand, maya)).batch.findings.find(item => item.id === finding.id).caseId, linked.case.id);
  assert((await send({ action: "list" }, jordan)).some(row => row.id === linked.case.id && row.assignee === "jordan"));

  docker(["rm", "-f", first]);
  await start(second);
  const freshJordan = await signIn(1);
  assert.deepEqual(await send({ action: "open", id }, freshJordan), resolved);
  const outsider = await signIn(2);
  assert.deepEqual(await send({ action: "list" }, outsider), []);
  assert.deepEqual(await send({ action: "open", id: linked.case.id }, freshJordan), linked);
  assert.equal((await request("/merchant/imports/" + batch.summary.id, outsider)).status, 404);
  assert.deepEqual(await send({ action: "listImports" }, outsider), []);
  for (const command of [{ action: "openImport", id: batch.summary.id }, { ...assign, assignee: "alex" }]) {
    assert.equal((await request("/api/merchant", { command, ...outsider })).status, 404);
  }
  console.log("PASS: refund evidence and its single assigned case survive container replacement; isolated merchant cannot open or assign the import.");
  assert.equal((await request("/merchant/" + id, outsider)).status, 404);
  for (const command of [{ action: "open", id }, { action: "note", id, revision: 5, note: "Cross-merchant attempt" }]) {
    const blocked = await request("/api/merchant", { command, ...outsider });
    assert.equal(blocked.status, 404);
    assert.deepEqual(JSON.parse(blocked.body), { error: "CASE_NOT_FOUND" });
  }
  console.log("PASS: HTTPS, host-only secure cookies, handoff, five events after container replacement, and second-merchant rejection.");
} finally {
  edge?.close();
  remove("rm", "-f", first, second);
  remove("volume", "rm", volume);
  rmSync(temp, { recursive: true, force: true });
}
