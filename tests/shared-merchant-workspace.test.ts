import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Employee, TeamCase, TeamCaseDetail, TeamSession } from "../src/merchant-team/contracts";
import { createTeamWorkspace } from "../src/merchant-team/handler";
import { TeamStore } from "../src/merchant-team/store";

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
    path,
    stop() { store.close(); stores.delete(store); },
    request(command: unknown, cookie = "", requestOrigin = origin, host = new URL(origin).host) {
      return workspace.handle(new Request(origin + "/api/merchant", {
        method: "POST", headers: { Host: host, Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json" },
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
  return {
    key, user: await response.json() as TeamSession,
    async send<T>(command: unknown) {
      const result = await server.request(command, key);
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
      const response = await server.request(command, alex.key);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "CASE_NOT_FOUND" });
    }
    expect((await server.request({ action: "assign", ...ref, assignee: "alex" }, maya.key)).status).toBe(422);
    expect((await server.request({ action: "list", merchantId: "harbor" }, alex.key)).status).toBe(400);
    expect(await maya.send<TeamCaseDetail>({ action: "open", id: item.id })).toMatchObject({ case: { revision: 1 } });
  });

  it("rejects forged sessions, bad origins and hosts, and invalidated sessions", async () => {
    const server = app();
    expect((await server.request({ action: "list" })).status).toBe(401);
    expect((await server.request({ action: "list" }, "changegate_team_session=" + "0".repeat(64))).status).toBe(401);
    expect((await server.request({ action: "signIn", username: "maya", password: "wrong" })).status).toBe(401);
    const maya = await signIn(server, "maya");
    expect((await server.request({ action: "list" }, maya.key, "https://external.example")).status).toBe(403);
    expect((await server.request({ action: "list" }, maya.key, origin, "external.example")).status).toBe(403);
    expect((await server.request({ action: "signOut" }, maya.key)).status).toBe(200);
    expect((await server.request({ action: "list" }, maya.key)).status).toBe(401);
    const jordan = await signIn(server, "jordan");
    server.stop();
    const restarted = app(server.path, roster.filter(({ username }) => username !== "jordan"));
    expect((await restarted.request({ action: "session" }, jordan.key)).status).toBe(401);
  });

  it("rejects a stale edit without adding an extra audit entry", async () => {
    const server = app();
    const maya = await signIn(server, "maya");
    const jordan = await signIn(server, "jordan");
    const { case: item } = await maya.send<TeamCaseDetail>({ action: "create", reference: "REF-015" });
    await maya.send<TeamCaseDetail>({ action: "note", id: item.id, revision: 1, note: "First note." });
    const stale = await server.request({ action: "note", id: item.id, revision: 1, note: "Stale note." }, jordan.key);
    expect(stale.status).toBe(409);
    const detail = await maya.send<TeamCaseDetail>({ action: "open", id: item.id });
    expect(detail.case.revision).toBe(2);
    expect(detail.history.map(({ detail }) => detail)).toEqual(["Initial owner: Maya Chen", "First note."]);
  });
});
