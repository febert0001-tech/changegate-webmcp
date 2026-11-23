import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee } from "../src/merchant-team/contracts";
import { createDemoAccess } from "../src/merchant-team/demo-access";
import { DemoInvites } from "../src/merchant-team/demo-invites";

const origin = "https://preview.example";
const host = new URL(origin).host;
const admin: Employee = { username: "jordan", name: "Jordan Lee", role: "manager", merchantId: "harbor",
  merchantName: "Harbor Goods", salt: "", passwordHash: "" };
const readTime = (value: string) => Date.parse("2026-11-23T" + value + "-05:00");
let clock: number;
let db: DatabaseSync;
let api: ReturnType<typeof createDemoAccess>;

beforeEach(() => {
  clock = readTime("13:59:15");
  db = new DatabaseSync(":memory:");
  api = createDemoAccess(new DemoInvites(db, () => clock), origin, true,
    headers => headers.get("host") === host, headers => headers.get("x-test-identity") === "admin" ? admin : undefined);
});
afterEach(() => db.close());

function post(body: unknown, actor = "guest", requestOrigin = origin) {
  return api.post(new Request(origin + "/api/demo-access", {
    method: "POST", headers: { host, origin: requestOrigin, "content-type": "application/json", "x-test-identity": actor },
    body: JSON.stringify(body),
  }));
}
function get(cookie = "") {
  return api.read(new Request(origin + "/api/demo-access", { headers: { host, cookie } }));
}
async function issue(minutes = 30) {
  const recipient = "Internal Reviewer";
  const plan = await post({ action: "plan", recipient, minutes }, "admin");
  expect(plan.status).toBe(200);
  const { startsAt, expiresAt } = await plan.json() as { startsAt: number; expiresAt: number };
  const input = { action: "issue", id: randomUUID(), recipient, minutes, startsAt };
  const created = await post(input, "admin");
  expect(created.status).toBe(200);
  const { token, code, id } = await created.json() as { token: string; code: string; id: string };
  return { id, input, startsAt, expiresAt, redeem: { action: "redeem", recipient, token, code } };
}

describe("expiring investor guest access", () => {
  it("preserves the 2:30 deadline after a 2:25 redemption, refresh and repeat sign-in", async () => {
    const pass = await issue();
    expect(pass.startsAt).toBe(readTime("14:00:00"));
    expect(pass.expiresAt).toBe(readTime("14:30:00"));
    expect((await post(pass.input, "admin")).status).toBe(409);
    expect((await post(pass.redeem)).status).toBe(403);
    clock = readTime("14:25:00");
    expect(get().status).toBe(401);
    expect((await post({ ...pass.redeem, recipient: "Forwarded Viewer" })).status).toBe(403);
    expect((await post({ ...pass.redeem, code: "A".repeat(24) })).status).toBe(403);
    expect((await post({ ...pass.redeem, code: "" })).status).toBe(400);
    expect((await post(pass.redeem, "guest", "https://different.example")).status).toBe(403);
    const attempts = await Promise.all([post(pass.redeem), post(pass.redeem)]);
    expect(attempts.map(reply => reply.status).sort()).toEqual([200,403]);
    const redemption = attempts.find(reply => reply.ok)!;
    const header = redemption.headers.get("set-cookie")!;
    expect(header).toMatch(/^__Host-changegate_demo_guest=.*HttpOnly.*Max-Age=300; Secure$/);
    const cookie = header.split(";")[0]!;
    const content = get(cookie);
    expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect(await content.json()).toMatchObject({ expiresAt: pass.expiresAt, remainingMs: 300_000,
      walkthrough: [{ title: "Held refund · Harbor Fuel" }, { title: "Recorded Square Sandbox result" }, { title: "Synthetic pilot scorecard" }] });
    clock = readTime("14:29:59");
    expect(await get(cookie).json()).toMatchObject({ expiresAt: pass.expiresAt, remainingMs: 1000 });
    expect((await post(pass.redeem)).status).toBe(403);
    clock = readTime("14:30:00");
    expect(get(cookie).status).toBe(401);
    expect((await post(pass.redeem)).status).toBe(403);
    expect(JSON.stringify(db.prepare("SELECT * FROM demo_invites").all())).not.toContain(pass.redeem.token);
    expect(JSON.stringify(db.prepare("SELECT * FROM demo_invites").all())).not.toContain(pass.redeem.code);
  });

  it("supports 60 minutes, revokes a live session, and rejects invalid admin requests", async () => {
    expect((await post({action:"list"})).status).toBe(403);
    expect((await post({action:"plan",recipient:"Internal Reviewer",minutes:61},"admin")).status).toBe(400);
    expect((await post({action:"plan",recipient:"Internal Reviewer",minutes:29},"admin")).status).toBe(400);
    expect((await post({action:"issue",id:randomUUID(),recipient:"Internal Reviewer",minutes:30,
      startsAt:readTime("13:58:00")},"admin")).status).toBe(409);
    const full = await issue(60);
    const stopped = await issue();
    clock = readTime("14:00:00");
    const fullCookie = (await post(full.redeem)).headers.get("set-cookie")!.split(";")[0]!;
    const stoppedCookie = (await post(stopped.redeem)).headers.get("set-cookie")!.split(";")[0]!;
    expect(get(stoppedCookie).status).toBe(200);
    expect((await post({action:"revoke",id:stopped.id})).status).toBe(403);
    expect((await post({action:"revoke",id:stopped.id},"admin")).status).toBe(200);
    expect(get(stoppedCookie).status).toBe(401);
    expect((await post(stopped.redeem)).status).toBe(403);
    clock = readTime("14:59:59");
    expect(await get(fullCookie).json()).toMatchObject({expiresAt:readTime("15:00:00"),remainingMs:1000});
    clock = readTime("15:00:00");
    expect(get(fullCookie).status).toBe(401);
    const list = await (await post({action:"list"},"admin")).json();
    expect(list).toMatchObject([{status:"Revoked"},{status:"Expired"}]);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(JSON.stringify(list)).not.toContain(full.redeem.token);
  });
});
