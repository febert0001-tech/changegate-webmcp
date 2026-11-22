import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestStatus, requestReceipt, type RefundRequest } from "../src/merchant-team/refund-requests";
import type { Employee, TeamCase, TeamCaseDetail, TeamSession, TeamWorkspaceView } from "../src/merchant-team/contracts";
import { createTeamWorkspace } from "../src/merchant-team/handler";
import { reviewSummaryCsv, type ReviewSummary } from "../src/merchant-team/review-summary";
import { TeamStore } from "../src/merchant-team/store";
import { reviewRefundCsv, type ImportSummary, type RefundImport, type RefundImportResult } from "../src/merchant-team/refund-csv";

const origin = "http://127.0.0.1:3190";
const password = "test-only-merchant-password";
const roster = [
  ["maya", "Maya Chen", "harbor", "Harbor Goods"],
  ["jordan", "Jordan Lee", "harbor", "Harbor Goods"],
  ["alex", "Alex Rivera", "ridge", "Ridge Market"],
].map(([username, name, merchantId, merchantName]) => {
  const salt = randomBytes(16);
  return { username, name, merchantId, merchantName, salt: salt.toString("hex"),
    passwordHash: scryptSync(password, salt, 32).toString("hex") } as Employee;
});
const folders: string[] = [];
const stores = new Set<TeamStore>();

function app(path?: string, users = roster) {
  if (!path) {
    const folder = mkdtempSync(join(tmpdir(), "changegate-team-"));
    folders.push(folder);
    path = join(folder, "merchant.sqlite");
  }
  const store = new TeamStore(path);
  stores.add(store);
  const workspace = createTeamWorkspace(store, users, origin);
  return {
    path, store,
    stop() { store.close(); stores.delete(store); },
    request(command: unknown, cookie = "", { requestOrigin = origin, host = new URL(origin).host, sessionVersion = "" } = {}) {
      return workspace.handle(new Request(origin + "/api/merchant", {
        method: "POST", headers: {
          Host: host, Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json",
          "X-ChangeGate-Session": sessionVersion,
        },
        body: JSON.stringify(command),
      }));
    },
  };
}
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function signIn(server: ReturnType<typeof app>, username: string) {
  const response = await server.request({ action: "signIn", username, password });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toMatch(/; HttpOnly; SameSite=Strict;/);
  const key = cookie?.split(";")[0];
  if (!key) throw Error("Signed-in response had no cookie");
  const user = await response.json() as TeamSession;
  return {
    key, user,
    request: (command: unknown) => server.request(command, key, { sessionVersion: user.sessionVersion }),
    async send<T>(command: unknown) {
      const result = await server.request(command, key, { sessionVersion: user.sessionVersion });
      expect(result.ok).toBe(true);
      return result.json() as Promise<T>;
    },
  };
}

describe("shared merchant workspace", () => {
  it("persists a named employee handoff, note, resolution and chronological history across restart", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const jordan = await signIn(server, "jordan");
    expect(jordan.key).not.toBe(maya.key);
    expect(maya.user.coworkers.map(({ username }) => username)).toEqual(["maya", "jordan"]);
    const { case: initial } = await maya.send<TeamCaseDetail>({ action: "create", reference: "REF-2468" });
    const { id } = initial;
    expect(await jordan.send<TeamCase[]>({ action: "list" })).toMatchObject([{ id, assignee: "maya" }]);
    await maya.send<TeamCaseDetail>({ action: "record", id, revision: 1, finding: "Processor entry received.",
      nextAction: "Confirm amount with order records.", status: "Awaiting evidence" });
    await maya.send<TeamCaseDetail>({ action: "assign", id, revision: 2, assignee: "jordan" });
    expect(await jordan.send<TeamCase[]>({ action: "list" })).toMatchObject([{ id, assignee: "jordan" }]);
    await jordan.send<TeamCaseDetail>({ action: "note", id, revision: 3, note: "Amount matched the order records." });
    const resolved = await jordan.send<TeamCaseDetail>({ action: "resolve", id, revision: 4 });
    expect(resolved.case).toMatchObject({ status: "Resolved", assigneeName: "Jordan Lee", revision: 5 });
    expect(resolved.history.map(({ actor, kind }) => [actor, kind])).toEqual([
      ["Maya Chen", "Opened"], ["Maya Chen", "Recorded finding"], ["Maya Chen", "Assigned"],
      ["Jordan Lee", "Added note"], ["Jordan Lee", "Resolved"],
    ]);
    expect(resolved.history[3]?.detail).toBe("Amount matched the order records.");
    expect(resolved.history.every(({ occurredAt }) => Number.isFinite(Date.parse(occurredAt)))).toBe(true);
    server.stop();
    const restarted = app(server.path);
    const reopened = await restarted.request({ action: "open", id }, jordan.key);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual(resolved);
  });

  it("scopes reads, mutations, assignments and roster data to the authenticated merchant", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const alex = await signIn(server, "alex");
    const { case: item } = await maya.send<TeamCaseDetail>({ action: "create", reference: "PRIVATE-2468" });
    expect(alex.user.coworkers).toEqual([{ username: "alex", name: "Alex Rivera" }]);
    expect(await alex.send<TeamCase[]>({ action: "list" })).toEqual([]);
    const ref = { id: item.id, revision: item.revision };
    for (const command of [
      { action: "open", id: item.id }, { action: "assign", ...ref, assignee: "alex" },
      { action: "note", ...ref, note: "Wrong merchant" }, { action: "resolve", ...ref },
      { action: "record", ...ref, finding: "Wrong merchant", nextAction: "Wrong merchant", status: "Investigating" },
    ]) {
      const response = await alex.request(command);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "CASE_NOT_FOUND" });
    }
    expect((await maya.request({ action: "assign", ...ref, assignee: "alex" })).status).toBe(422);
    expect((await server.request({ action: "list", merchantId: "harbor" }, alex.key)).status).toBe(400);
    expect(await maya.send<TeamCaseDetail>({ action: "open", id: item.id })).toMatchObject({ case: { revision: 1 } });
  });

  it("rejects forged sessions, bad origins and hosts, and invalidated sessions", async () => {
    const server = app();
    expect((await server.request({ action: "list" })).status).toBe(401);
    expect((await server.request({ action: "list" }, "changegate_team_session=" + "0".repeat(64))).status).toBe(401);
    expect((await server.request({ action: "signIn", username: "maya", password: "wrong" })).status).toBe(401);
    const maya = await signIn(server, "maya");
    expect((await server.request({ action: "list" }, maya.key, { requestOrigin: "https://external.example" })).status).toBe(403);
    expect((await server.request({ action: "list" }, maya.key, { host: "external.example" })).status).toBe(403);
    expect((await maya.request({ action: "signOut" })).status).toBe(200);
    expect((await server.request({ action: "list" }, maya.key)).status).toBe(401);
    const jordan = await signIn(server, "jordan");
    server.stop();
    const restarted = app(server.path, roster.filter(({ username }) => username !== "jordan"));
    expect((await restarted.request({ action: "session" }, jordan.key)).status).toBe(401);
    restarted.stop();
    const restored = app(server.path);
    expect((await restored.request({ action: "session" }, jordan.key)).status).toBe(401);
    expect((await signIn(restored, "jordan")).user.username).toBe("jordan");
  });

  it("keeps a session invalid after a password is changed and later restored", async () => {
    const original = app();
    const maya = await signIn(original, "maya");
    const jordan = await signIn(original, "jordan");
    original.stop();
    const rotated = app(original.path, roster.map((employee) => employee.username === "maya"
      ? { ...employee, passwordHash: randomBytes(32).toString("hex") } : employee));
    expect((await rotated.request({ action: "session" }, maya.key)).status).toBe(401);
    expect((await rotated.request({ action: "session" }, jordan.key)).status).toBe(200);
    rotated.stop();
    const restored = app(original.path);
    expect((await restored.request({ action: "session" }, maya.key)).status).toBe(401);
    expect((await restored.request({ action: "session" }, jordan.key)).status).toBe(200);
  });

  it("refreshes identity, queue, and case together and denies writes from a stale view", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const alex = await signIn(server, "alex");
    const { case: privateCase } = await maya.send<TeamCaseDetail>({ action: "create", reference: "HARBOR-PRIVATE" });
    const { case: ownCase } = await alex.send<TeamCaseDetail>({ action: "create", reference: "RIDGE-PRIVATE" });

    const before = await maya.send<TeamWorkspaceView>({ action: "workspace", id: privateCase.id });
    expect(before).toMatchObject({ session: { username: "maya" }, cases: [{ id: privateCase.id }],
      detail: { case: { id: privateCase.id } } });
    const after = await alex.send<TeamWorkspaceView>({ action: "workspace", id: privateCase.id });
    expect(after).toMatchObject({ session: { username: "alex" }, cases: [{ id: ownCase.id }], detail: null });
    expect(JSON.stringify(after)).not.toContain(privateCase.reference);

    const staleBinding = { sessionVersion: before.session.sessionVersion };
    const staleCreate = await server.request({ action: "create", reference: "HARBOR-SECRET" }, alex.key, staleBinding);
    expect(staleCreate.status).toBe(409);
    expect(await staleCreate.json()).toEqual({ error: "SESSION_CHANGED" });
    expect((await server.request({ action: "signOut" }, alex.key, staleBinding)).status).toBe(409);
    expect((await server.request({ action: "create", reference: "MISSING-BINDING" }, alex.key)).status).toBe(409);
    expect(await alex.send<TeamCase[]>({ action: "list" })).toMatchObject([{ id: ownCase.id }]);

    await alex.request({ action: "signOut" });
    const expired = await alex.request({ action: "workspace", id: ownCase.id });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "SIGN_IN_REQUIRED" });
  });

  it("consumes one old session across concurrent sign-ins and revokes the winning replacement on sign-out", async () => {
    const server = app();
    const original = await signIn(server, "maya");
    const independent = await signIn(server, "jordan");
    const attempts = await Promise.all([
      server.request({ action: "signIn", username: "alex", password }, original.key),
      server.request({ action: "signIn", username: "jordan", password }, original.key),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = attempts.find(({ ok }) => ok);
    const loser = attempts.find(({ status }) => status === 409);
    if (!winner || !loser) throw Error("Expected one replacement");
    expect(loser.headers.get("set-cookie")).toBeNull();
    expect(await loser.json()).toEqual({ error: "SESSION_CHANGED" });
    const replacement = winner.headers.get("set-cookie")?.split(";")[0];
    if (!replacement) throw Error("Replacement cookie missing");
    const session = await winner.json() as TeamSession;
    expect((await server.request({ action: "session" }, original.key)).status).toBe(401);
    expect((await server.request({ action: "session" }, replacement)).status).toBe(200);
    const signOut = await server.request({ action: "signOut" }, replacement, { sessionVersion: session.sessionVersion });
    expect(signOut.status).toBe(200);
    expect((await server.request({ action: "session" }, replacement)).status).toBe(401);
    expect((await server.request({ action: "signIn", username: "alex", password }, original.key)).status).toBe(409);
    expect((await independent.request({ action: "session" })).status).toBe(200);
  });

  it("recovers once from the old cookie when a successful sign-out response is lost", async () => {
    const server = app();
    const old = await signIn(server, "maya");
    expect((await old.request({ action: "signOut" })).status).toBe(200);
    expect((await old.request({ action: "session" })).status).toBe(401);

    const regular = await server.request({ action: "signIn", username: "alex", password }, old.key);
    expect(regular.status).toBe(409);
    expect(regular.headers.get("set-cookie")).toBeNull();
    expect(await regular.json()).toEqual({ error: "SIGN_IN_RECOVERY_REQUIRED" });
    expect((await server.request({ action: "signIn", username: "alex", password: "wrong", recoverSession: true }, old.key)).status).toBe(401);

    const recover = { action: "signIn", username: "alex", password, recoverSession: true };
    const responses = await Promise.all([server.request(recover, old.key), server.request(recover, old.key)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = responses.find(({ ok }) => ok);
    const replacement = winner?.headers.get("set-cookie")?.split(";")[0];
    if (!replacement) throw Error("Recovered session cookie missing");
    expect(await winner?.json()).toMatchObject({ username: "alex" });
    expect((await server.request({ action: "session" }, replacement)).status).toBe(200);
    expect((await server.request({ action: "session" }, old.key)).status).toBe(401);
    expect((await server.request(recover, old.key)).status).toBe(409);
  });

  it("recovers a lost replacement response only for the employee issued the unseen session", async () => {
    const server = app();
    const old = await signIn(server, "maya");
    const first = await server.request({ action: "signIn", username: "jordan", password }, old.key);
    expect(first.status).toBe(200);
    const unseen = first.headers.get("set-cookie")?.split(";")[0];
    if (!unseen) throw Error("Replacement response missing cookie");

    const unrelated = await server.request({ action: "signIn", username: "alex", password, recoverSession: true }, old.key);
    expect(unrelated.status).toBe(409);
    expect((await server.request({ action: "session" }, unseen)).status).toBe(200);
    const regular = await server.request({ action: "signIn", username: "jordan", password }, old.key);
    expect(regular.status).toBe(409);
    expect(await regular.json()).toEqual({ error: "SIGN_IN_RECOVERY_REQUIRED" });

    const recovery = { action: "signIn", username: "jordan", password, recoverSession: true };
    const attempts = await Promise.all([server.request(recovery, old.key), server.request(recovery, old.key)]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 409]);
    const recovered = attempts.find(({ ok }) => ok)?.headers.get("set-cookie")?.split(";")[0];
    if (!recovered) throw Error("Recovery response missing cookie");
    expect((await server.request({ action: "session" }, unseen)).status).toBe(401);
    expect((await server.request({ action: "session" }, recovered)).status).toBe(200);
  });

  it("rejects a case write if a separate connection revokes the session after authentication", async () => {
    const server = app();
    const other = app(server.path);
    const maya = await signIn(server, "maya");
    const jordan = await signIn(server, "jordan");
    const { case: item } = await maya.send<TeamCaseDetail>({ action: "create", reference: "REF-ACTIVE-SESSION" });

    const create = server.store.create.bind(server.store);
    vi.spyOn(server.store, "create").mockImplementationOnce((employee, reference, token) => {
      other.store.revokeSession(token);
      return create(employee, reference, token);
    });
    expect((await maya.request({ action: "create", reference: "REVOKED-CREATE" })).status).toBe(401);
    expect(await jordan.send<TeamCase[]>({ action: "list" })).toMatchObject([{ id: item.id }]);

    const change = server.store.change.bind(server.store);
    vi.spyOn(server.store, "change").mockImplementationOnce((employee, command, users, token) => {
      other.store.revokeSession(token);
      return change(employee, command, users, token);
    });
    expect((await jordan.request({ action: "note", id: item.id, revision: 1, note: "REVOKED-NOTE" })).status).toBe(401);
    const fresh = await signIn(server, "maya");
    const detail = await fresh.send<TeamCaseDetail>({ action: "open", id: item.id });
    expect(detail.case.revision).toBe(1);
    expect(detail.history.map(({ kind }) => kind)).toEqual(["Opened"]);
  });

  it("uses secure hosted cookies, validates Railway ingress, and throttles sign-in attempts", async () => {
    const server = app();
    const hostedOrigin = "https://changegate-qa.up.railway.app";
    const host = new URL(hostedOrigin).host;
    const hosted = createTeamWorkspace(server.store, roster, hostedOrigin, { staging: true });
    const signIn = { action: "signIn", username: "maya", password };
    function request(command: unknown, options: Record<string, string> = {}) {
      return hosted.handle(new Request(hostedOrigin + "/api/merchant", {
        method: "POST", headers: {
          Host: host, Origin: hostedOrigin, "Content-Type": "application/json",
          "X-Forwarded-Proto": "https", "X-Forwarded-Host": host, "X-Real-IP": "192.0.2.4", ...options,
        },
        body: JSON.stringify(command),
      }));
    }

    expect((await request(signIn, { "X-Forwarded-Proto": "http" })).status).toBe(403);
    expect((await request(signIn, { "X-Forwarded-Host": "untrusted.example" })).status).toBe(403);
    expect((await request(signIn, { "X-Real-IP": "" })).status).toBe(403);
    const accepted = await request(signIn);
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie");
    expect(cookie).toMatch(/^__Host-changegate_team_session=.*; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/);
    const key = cookie?.split(";")[0];
    if (!key) throw Error("Expected hosted cookie");
    expect((await request({ action: "session" }, { Cookie: key })).status).toBe(200);
    expect((await request({ action: "session" }, { Cookie: key.replace("__Host-", "") })).status).toBe(401);

    for (let i = 0; i < 29; i++) {
      expect((await request({ ...signIn, password: "incorrect" })).status).toBe(401);
    }
    expect((await request(signIn)).status).toBe(429);
    expect((await request(signIn, { "X-Real-IP": "192.0.2.5" })).status).toBe(200);
  });

  it("previews redacted rows, reports rejection reasons, and describes a repeat without inferring a second payment", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const text = readFileSync("tests/fixtures/TEST-only-refund-export.csv", "utf8");
    const mapping = { reference: 0, amount: 1, currency: 2, status: 3 };
    const inspection = await maya.send<{ headers: string[]; rowCount: number }>({ action: "inspectCsv", text });
    expect(inspection.headers[0]).toBe("export_ref");
    expect(inspection.rowCount).toBe(6);
    const preview = await maya.send<ReturnType<typeof reviewRefundCsv>>({ action: "previewCsv", text, mapping });
    expect(preview.accepted).toHaveLength(4);
    expect(preview.rejections).toEqual([
      { line: 5, reasons: ["Amount must be a positive number with up to two decimal places."] },
      { line: 6, reasons: ["Currency must be USD."] },
    ]);
    expect(preview.findings[0]).toMatchObject({ kind: "Repeated reference", rows: [{ line: 2 }, { line: 3 }] });
    expect(preview.findings[0]?.explanation).toContain("cannot establish that money moved twice");
    expect(preview.findings[1]).toMatchObject({ kind: "Status needs review", rows: [{ line: 4, status: "PENDING" }] });
    expect(JSON.stringify(preview)).not.toContain("IGNORE_TEST_COLUMN");
    expect(await maya.send<ImportSummary[]>({ action: "listImports" })).toEqual([]);
    expect((await maya.request({ action: "previewCsv", text, mapping: { ...mapping, amount: 0 } })).status).toBe(400);
    const quoted = reviewRefundCsv('id,amount,currency,memo\nONE,12,USD,"two\nlines"\nTWO,5,USD,done', { reference: 0, amount: 1, currency: 2 });
    expect(quoted.accepted.map(({ line }) => line)).toEqual([2, 4]);
  });

  it("links each finding to one assigned case across repeats, restarts, and separate merchants", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const jordan = await signIn(server, "jordan");
    const alex = await signIn(server, "alex");
    const text = readFileSync("tests/fixtures/TEST-only-refund-export.csv", "utf8");
    const command = { action: "importCsv", text, mapping: { reference: 0, amount: 1, currency: 2, status: 3 } };
    const [imported, repeated] = await Promise.all([maya.send<RefundImportResult>(command), maya.send<RefundImportResult>(command)]);
    expect([imported.existing, repeated.existing].sort()).toEqual([false, true]);
    expect(imported.batch).toEqual(repeated.batch);
    const finding = imported.batch.findings[0];
    if (!finding) throw Error("Expected a repeated-reference finding");
    const assign = { action: "assignFinding", id: finding.id, assignee: "jordan" };
    const [opened, duplicate] = await Promise.all([maya.send<TeamCaseDetail>(assign), maya.send<TeamCaseDetail>(assign)]);
    expect(opened.case.id).toBe(duplicate.case.id);
    expect(opened.case.assignee).toBe("jordan");
    expect(opened.evidence?.finding.rows).toHaveLength(2);
    expect(opened.history.map(({ kind }) => kind)).toEqual(["Opened", "Imported evidence", "Assigned"]);
    expect(await jordan.send<TeamCase[]>({ action: "list" })).toMatchObject([{ id: opened.case.id, assignee: "jordan" }]);
    const original = await maya.send<RefundImportResult>(command);
    expect(original.batch.findings[0]?.caseId).toBe(opened.case.id);
    expect(await alex.send<ImportSummary[]>({ action: "listImports" })).toEqual([]);
    expect((await alex.request({ action: "openImport", id: imported.batch.summary.id })).status).toBe(404);
    expect((await alex.request({ ...assign, assignee: "alex" })).status).toBe(404);
    expect((await alex.request({ action: "open", id: opened.case.id })).status).toBe(404);
    const secondMerchant = await alex.send<RefundImportResult>(command);
    expect(secondMerchant.batch.summary.id).not.toBe(imported.batch.summary.id);
    expect(secondMerchant.batch.findings[0]?.caseId).toBeNull();

    server.stop();
    const restarted = app(server.path);
    const coworker = await signIn(restarted, "jordan");
    expect(await coworker.send<TeamCaseDetail>({ action: "open", id: opened.case.id })).toEqual(opened);
    const persisted = await coworker.send<RefundImport>({ action: "openImport", id: imported.batch.summary.id });
    expect(persisted.findings[0]?.caseId).toBe(opened.case.id);
    expect(JSON.stringify(persisted)).not.toContain("IGNORE_TEST_COLUMN");
  });

  it("rejects a stale edit without adding an extra audit entry", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const jordan = await signIn(server, "jordan");
    const { case: item } = await maya.send<TeamCaseDetail>({ action: "create", reference: "REF-015" });
    await maya.send<TeamCaseDetail>({ action: "note", id: item.id, revision: 1, note: "First note." });
    const stale = await jordan.request({ action: "note", id: item.id, revision: 1, note: "Stale note." });
    expect(stale.status).toBe(409);
    const detail = await maya.send<TeamCaseDetail>({ action: "open", id: item.id });
    expect(detail.case.revision).toBe(2);
    expect(detail.history.map(({ detail }) => detail)).toEqual(["Initial owner: Maya Chen", "First note."]);
  });
  it("reuses comparison and assigned case IDs, persists both source rows, and scopes evidence to the merchant", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const alex = await signIn(server, "alex");
    const mapping = { reference: 0, amount: 1, currency: 2 };
    const file = (name: string) => ({ name, mapping, text: readFileSync("tests/fixtures/" + name, "utf8") });
    const input = {
      merchant: file("TEST-only-merchant-register.csv"),
      processor: file("TEST-only-processor-export.csv"),
      period: { start: "2026-11-01", end: "2026-11-07" },
    };
    expect(await maya.send({ action: "previewComparison", input })).toMatchObject({ acceptedCount: 10 });
    expect(await maya.send({ action: "listImports" })).toEqual([]);
    const command = { action: "saveComparison", input };
    const { batch } = await maya.send<RefundImportResult>(command);
    const finding = batch.findings.find(row => row.differenceCents === 1800);
    if (!finding) throw Error("Amount difference missing");
    const assign = { action: "assignFinding", id: finding.id, assignee: "jordan" };
    const [original, repeat] = await Promise.all([maya.send<TeamCaseDetail>(assign), maya.send<TeamCaseDetail>(assign)]);
    expect(repeat).toEqual(original);
    const reused = await maya.send<RefundImportResult>(command);
    expect(reused.existing).toBe(true);
    expect(reused.batch.summary.id).toBe(batch.summary.id);
    expect(reused.batch.findings.find(row => row.id === finding.id)?.caseId).toBe(original.case.id);
    expect(await alex.send({ action: "listImports" })).toEqual([]);
    expect((await alex.request({ ...assign, assignee: "alex" })).status).toBe(404);
    expect((await alex.request({ action: "openImport", id: batch.summary.id })).status).toBe(404);
    expect((await alex.request({ action: "open", id: original.case.id })).status).toBe(404);
    server.stop();

    const restarted = app(server.path);
    const jordan = await signIn(restarted, "jordan");
    const persisted = await jordan.send<TeamCaseDetail>({ action: "open", id: original.case.id });
    expect(persisted).toEqual(original);
    expect(persisted.evidence?.comparison).toEqual({
      period: input.period,
      files: { Merchant: input.merchant.name, Processor: input.processor.name },
    });
    expect(persisted.evidence?.finding.rows.map(row => [row.side, row.line, row.amountCents]))
      .toEqual([["Merchant", 2, 4200], ["Processor", 2, 2400]]);
    expect(await jordan.send({ action: "list" })).toMatchObject([{ assignee: "jordan", differenceCents: 1800 }]);
    const report = { action: "reviewSummary", id: batch.summary.id };
    const initial = await jordan.send<ReviewSummary>(report);
    expect(initial.files.map(({ accepted, rejected }) => [accepted, rejected])).toEqual([[5, 1], [5, 0]]);
    expect(initial.matches).toEqual(["TEST-MATCH-1001"]);
    expect(initial.counts).toEqual([
      { kind: "Amount difference", count: 1 }, { kind: "Merchant only", count: 1 },
      { kind: "Ambiguous reference", count: 2 }, { kind: "Processor only", count: 1 },
    ]);
    expect(initial.needsInvestigation).toBe(5);
    const decision = { action: "recordDisposition", id: batch.summary.id, findingId: finding.id,
      expectedRevision: 0, disposition: "Timing difference", note: '=TEST, "next close"' };
    const decided = await jordan.send<ReviewSummary>(decision);
    expect(decided.exceptions.find(row => row.id === finding.id)).toMatchObject({
      assigneeName: "Jordan Lee", caseStatus: "Awaiting evidence", needsInvestigation: true,
      decision: { reviewer: "Jordan Lee", revision: 1, recordedAt: expect.stringMatching(/Z$/), note: decision.note },
    });
    expect((await jordan.request(decision)).status).toBe(409);
    expect((await jordan.request({ ...decision, id: original.case.id })).status).toBe(404);
    const foreign = await signIn(restarted, "alex");
    expect((await foreign.request(report)).status).toBe(404);
    expect((await foreign.request(decision)).status).toBe(404);
    const comparisonRepeat = await jordan.send<RefundImportResult>(command);
    expect(comparisonRepeat.existing).toBe(true);
    expect(await jordan.send<ReviewSummary>(report)).toEqual(decided);

    await jordan.send({ action: "resolve", id: original.case.id, revision: original.case.revision });
    const closed = await jordan.send<ReviewSummary>(report);
    expect(closed.needsInvestigation).toBe(4);
    const csv = reviewSummaryCsv(closed);
    expect(csv).toContain('"Summary","Exceptions","5"');
    expect(csv).toContain('"Exception count","Ambiguous reference","2"');
    expect(csv).toContain('"Match","TEST-MATCH-1001"');
    expect(csv).toContain('"Jordan Lee","Resolved","No","Timing difference","Jordan Lee"');
    expect(csv).toContain("\"'=TEST, \"\"next close\"\"\"");
    const unresolved = await jordan.send<ReviewSummary>({ ...decision, expectedRevision: 1, disposition: "Still unresolved" });
    expect(unresolved.needsInvestigation).toBe(5);
    restarted.stop();
    const reopened = app(server.path);
    expect(await (await signIn(reopened, "maya")).send<ReviewSummary>(report)).toEqual(unresolved);
  });

  it("keeps the reporting period and reviewed column interpretation in comparison identity", async () => {
    const reviewer = await signIn(app(), "maya");
    const mapping = { reference: 0, amount: 1, currency: 3 };
    const file = (name: string, amounts: string) => ({
      name, text: "reference,amount,adjusted,currency\nREF-1," + amounts + ",USD", mapping,
    });
    const input = {
      merchant: file("merchant.csv", "42.00,24.00"), processor: file("processor.csv", "24.00,24.00"),
      period: { start: "2026-11-01", end: "2026-11-07" },
    };
    const save = (inputData = input) => reviewer.send<RefundImportResult>({ action: "saveComparison", input: inputData });
    const original = await save();
    expect(original.batch.findings[0]?.differenceCents).toBe(1800);
    const repeated = await save({ ...input, merchant: { ...input.merchant, name: "renamed.csv" } });
    expect(repeated).toMatchObject({ existing: true, batch: { summary: { id: original.batch.summary.id } } });
    const period = { start: "2026-11-08", end: "2026-11-14" };
    const nextWeek = await save({ ...input, period });
    expect(nextWeek.existing).toBe(false);
    expect(nextWeek.batch.comparison?.period).toEqual(period);
    const corrected = await save({ ...input, merchant: { ...input.merchant, mapping: { ...mapping, amount: 2 } } });
    expect(corrected.existing).toBe(false);
    expect(corrected.batch.findings).toEqual([]);
    expect(corrected.batch.comparison?.exact).toHaveLength(1);
    expect((await save()).batch.summary.id).toBe(original.batch.summary.id);
  });

  it("enforces cumulative limits, persisted cash reports, separate managers and merchant isolation", async () => {
    const roles: Employee[] = roster.map(employee => ({ ...employee, role: employee.username === "jordan" ? "manager" as const : "cashier" as const }));
    roles.push({ ...roles[0]!, username: "owner", role: "owner", name: "Store Owner" });
    const server = app(undefined, roles);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const owner = await signIn(server, "owner");
    const outsider = await signIn(server, "alex");
    expect((await cashier.request({ action: "setRefundPolicy", thresholdCents: 5000 })).status).toBe(403);
    expect(await owner.send({ action: "setRefundPolicy", thresholdCents: 5000 })).toEqual({ thresholdCents: 5000 });
    const command = (reference: string, amount: string) => ({ action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference, amount, currency: "USD", reason: "Test correction" } });
    const initial = command("TEST-SALE-PARTIAL", "18.00");
    const first = await cashier.send<RefundRequest>(initial);
    expect(requestStatus(first)).toBe("Ready for cash payout");
    expect(await cashier.send(initial)).toEqual(first);
    const cash = { action: "reportCashPayout", id: first.id };
    const paid = await cashier.send<RefundRequest>(cash);
    expect(requestStatus(paid)).toBe("Cash payout recorded");
    expect(await cashier.send(cash)).toEqual(paid);
    const second = await cashier.send<RefundRequest>(command("TEST-SALE-PARTIAL", "8.00"));
    expect(requestStatus(second)).toBe("Needs manager decision");
    expect(JSON.stringify(second)).toContain("bring refunds on this sale to $55.00");
    expect((await cashier.request({ action: "reportCashPayout", id: second.id })).status).toBe(409);
    const approve = { action: "decideRefundRequest", id: second.id, decision: "Approved", password };
    expect((await cashier.request(approve)).status).toBe(403);
    expect((await outsider.request(approve)).status).toBe(404);
    expect(await outsider.send({ action: "listRefundRequests" })).toEqual([]);
    expect((await manager.request({ ...approve, password: "incorrect" })).status).toBe(403);
    const approved = await manager.send<RefundRequest>(approve);
    expect(await manager.send(approve)).toEqual(approved);
    const over = await cashier.send<RefundRequest>(command("TEST-SALE-BALANCE", "42.00"));
    expect(requestStatus(over)).toBe("Blocked · Over refundable balance");
    expect(JSON.stringify(over)).toContain("Only $24.00 remains refundable.");
    const own = await manager.send<RefundRequest>(command("TEST-SALE-ELECTRONIC", "55.00"));
    expect((await manager.request({ ...approve, id: own.id })).status).toBe(403);
    const approvedElectronic = await owner.send<RefundRequest>({ ...approve, id: own.id });
    expect(requestStatus(approvedElectronic)).toBe("Blocked · Processor not connected");
    expect(requestReceipt(approvedElectronic)).toMatchObject({ execution: { status: "Not submitted", attempt: null },
      verification: { status: "Not run", independentReadback: null } });
    const fourth = await cashier.send<RefundRequest>(command("TEST-SALE-CASH", "2.00"));
    expect(requestStatus(fourth)).toBe("Needs manager decision");
    expect(JSON.stringify(fourth)).toContain("fourth or later");
    server.stop();
    const restored = app(server.path, roles);
    expect(await (await signIn(restored, "maya")).send({ action: "openRefundRequest", id: second.id })).toEqual(approved);
  });
});
