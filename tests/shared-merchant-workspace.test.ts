import { pilotSummaryText } from "../src/merchant-team/pilot-summary";
import type { PilotView } from "../src/merchant-team/pilot-review";
import { coverageInstant } from "../src/merchant-team/coverage-time";
import { overnightAccounts, type OvernightQueue, type OvernightOwner, type CoverageSettingsView } from "../src/merchant-team/overnight";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessSize, observeRefundShare } from "../src/merchant-team/refund-monitor-rules";
import { checks, requestStatus, requestReceipt, type RefundRequest } from "../src/merchant-team/refund-requests";
import { demoAccounts, generateDemoEvents, type DemoState } from "../src/merchant-team/demo-shift";
import type { DiscountCommand, DiscountSale } from "../src/merchant-team/discount-contracts";
import { shiftGroups, type ShiftOverview } from "../src/merchant-team/shift-overview";
import { demoExplanation } from "../src/merchant-team/refund-ai-explanation";
import type { Employee, TeamCase, TeamCaseDetail, TeamSession, TeamWorkspaceView } from "../src/merchant-team/contracts";
import type { CashDrawerView } from "../src/merchant-team/cash-drawers";
import { cashWeekGroups, originalVarianceTotal, type CashWeek } from "../src/merchant-team/weekly-cash-review";
import { createTeamWorkspace } from "../src/merchant-team/handler";
import { reviewSummaryCsv, type ReviewSummary } from "../src/merchant-team/review-summary";
import { TeamStore } from "../src/merchant-team/store";
import { SquareSandbox } from "../src/merchant-team/square-sandbox";
import { configuredPayPalSandbox, PayPalProvider } from "../src/merchant-team/paypal-provider";
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
const children = new Set<ChildProcess>();

function app(path?: string, users = roster, clock?: () => string, square?: SquareSandbox, paypal?: PayPalProvider, demo = false, hostedDemo = false) {
  if (!path) {
    const folder = mkdtempSync(join(tmpdir(), "changegate-team-"));
    folders.push(folder);
    path = join(folder, "merchant.sqlite");
  }
  const store = new TeamStore(path, clock, demo);
  stores.add(store);
  const workspace = createTeamWorkspace(store, users, origin, { hostedDemo, ...(square && { square }), ...(paypal && { paypal }) });
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
afterEach(async () => {
  for (const child of children) {
    const exited = once(child, "exit");
    child.disconnect();
    await exited;
  }
  children.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function signIn(server: Pick<ReturnType<typeof app>, "request">, username: string) {
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

describe("local Harbor Bar discount approval", () => {
  const action = (command: DiscountCommand) => ({ action: "demoDiscount", command });

  it("adds one net cash sale to the Harbor Bar drawer and balances at close", async () => {
    const users = demoAccounts.map(account => {
      const salt = randomBytes(16);
      return { ...account, salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") } as Employee;
    });
    const server = app(undefined, users, undefined, undefined, undefined, true);
    const [maya, jordan, alex] = await Promise.all(["maya", "jordan", "alex"].map(user => signIn(server, user)));
    const reference = "DEMO-SALE-" + randomUUID();
    const fuelId = randomUUID(), barId = randomUUID();
    await maya!.send({ action: "openCashDrawer", id: fuelId, cents: 10000 });
    await maya!.send(action({ operation: "start", reference, original: "100.00", discount: "30.00" }));
    await jordan!.send(action({ operation: "decide", reference, revision: 1, decision: "Approved", password }));
    const finish = action({ operation: "finish", reference, revision: 1, choice: "discounted", tender: "Cash" });
    expect(await (await maya!.request(finish)).json()).toEqual({error:"DISCOUNT_CASH_DRAWER_REQUIRED"});
    expect((await maya!.request({ action: "openDemoSale", reference })).status).toBe(404);
    const opened = await maya!.send({ action: "openCashDrawer", id: barId, cents: 10000, register: "harbor-bar" });
    expect(opened).toMatchObject({ activeId: barId, drawer: { location: "Harbor Bar", register: "Bar 1",
      opening: { cents: 10000 }, report: null } });
    expect((await alex!.request({ action: "cashDrawers", id: barId, register: "harbor-bar" })).status).toBe(404);
    const [sale, replay] = await Promise.all([maya!.send<DiscountSale>(finish), maya!.send<DiscountSale>(finish)]);
    expect(sale).toEqual(replay);
    expect(sale.completion).toMatchObject({ subtotalCents: 7000, tender: "Cash" });
    expect(await maya!.send({ action: "openDemoSale", reference })).toMatchObject({ sale: { tender: "Cash",
      originalCents: 7000, discountCents: 3000 } });
    expect(await maya!.send({ action: "cashDrawers", id: barId, register: "harbor-bar" })).toMatchObject({ drawer: { report: null } });
    const closed = await maya!.send({ action: "closeCashDrawer", id: barId, cents: 17000 });
    expect(closed).toMatchObject({ drawer: { report: { variance: 0, expected: 17000,
      firstCount: { cents: 17000 }, entries: [{ id: reference, kind: "sale", cents: 7000 }] } } });
    expect(await maya!.send(finish)).toEqual(sale);
    expect(await jordan!.send({ action: "cashDrawers", id: barId })).toMatchObject({ drawer: { report: {
      expected: 17000, variance: 0, entries: [{ id: reference, kind: "sale", cents: 7000 }],
    } } });
    expect(await maya!.send({ action: "closeCashDrawer", id: fuelId, cents: 10000 })).toMatchObject({ drawer: {
      report: { expected: 10000, variance: 0, entries: [] },
    } });
    const groups = shiftGroups(await jordan!.send<ShiftOverview>({ action: "shiftOverview", manual: true }), "Harbor Bar");
    expect(groups.sales.map(row => row.amountCents)).toEqual([7000]);
    expect(groups.discounts.map(row => row.amountCents)).toEqual([3000]);
    expect(groups.refunds).toEqual([]);
    expect(groups.payouts).toEqual([]);
  });

  it("requires an open drawer before recording a cash payout and posts it once to the paying shift", async () => {
    const ownerAccount = { ...demoAccounts[2]!, username: "shop-owner", name: "Harbor Owner", role: "owner" };
    const users = [...demoAccounts, ownerAccount].map(account => {
      const salt = randomBytes(16);
      return { ...account, salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") } as Employee;
    });
    let clock = "2026-11-24T23:00:00.000Z";
    const server = app(undefined, users, () => clock, undefined, undefined, true);
    const [maya, robin, jordan, owner] = await Promise.all(
      ["maya", "qa-cashier-b", "jordan", "shop-owner"].map(user => signIn(server, user)),
    );
    await owner!.send({ action: "setRefundPolicy", thresholdCents: 2000 });
    const shiftA = randomUUID(), shiftB = randomUUID();
    const reference = "DEMO-SALE-" + randomUUID();
    await maya!.send({ action: "openCashDrawer", id: shiftA, cents: 10000, register: "harbor-bar" });
    await maya!.send(action({ operation: "start", reference, original: "100.00", discount: "30.00" }));
    await jordan!.send(action({ operation: "decide", reference, revision: 1, decision: "Approved", password }));
    await maya!.send(action({ operation: "finish", reference, revision: 1, choice: "discounted", tender: "Cash" }));
    const refund = await maya!.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference, amount: "20.00", currency: "USD", reason: "Synthetic later-shift cash refund" } });
    const approved = await jordan!.send<RefundRequest>({
      action: "decideRefundRequest", id: refund.id, decision: "Approved", password,
    });
    expect(requestReceipt(approved)).toMatchObject({
      decision: { status: "Approved", reviewer: "Jordan Lee" }, execution: { status: "Not submitted" },
    });
    const first = await maya!.send<CashDrawerView>({ action: "closeCashDrawer", id: shiftA, cents: 17000 });
    expect(first.drawer?.report).toMatchObject({
      expected: 17000, firstCount: { cents: 17000 }, variance: 0,
      entries: [{ kind: "sale", id: reference, cents: 7000 }],
    });

    clock = "2026-11-25T11:00:00.000Z";
    const payout = { action: "reportCashPayout", id: refund.id };
    const blocked = await robin!.request(payout);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "CASH_PAYOUT_DRAWER_REQUIRED" });
    const openRefund = { action: "openRefundRequest", id: refund.id };
    expect(await maya!.send<RefundRequest>(openRefund)).toEqual(approved);
    expect(await robin!.send({ action: "cashDrawers", register: "harbor-bar" })).toMatchObject({ activeId: null });

    await robin!.send({ action: "openCashDrawer", id: shiftB, cents: 10000, register: "harbor-bar" });
    const paid = await robin!.send<RefundRequest>(payout);
    expect(await robin!.send<RefundRequest>(payout)).toEqual(paid);
    expect(paid.events.filter(event => event.kind === "Cash payout reported")).toEqual([
      { kind: "Cash payout reported", actor: "Robin Davis", occurredAt: clock },
    ]);
    const second = await robin!.send<CashDrawerView>({ action: "closeCashDrawer", id: shiftB, cents: 8000 });
    expect(second.drawer?.report).toMatchObject({
      expected: 8000, firstCount: { cents: 8000 }, variance: 0,
      entries: [{ id: refund.id, kind: "payout", cents: -2000, actor: "Robin Davis", at: clock }],
    });
    expect(await robin!.send<RefundRequest>(payout)).toEqual(paid);
    expect((await owner!.send<CashDrawerView>({ action: "cashDrawers", id: shiftA })).drawer).toEqual(first.drawer);
    expect((await owner!.send<CashDrawerView>({ action: "cashDrawers", id: shiftB })).drawer).toEqual(second.drawer);
    expect(requestReceipt(await owner!.send<RefundRequest>(openRefund))).toMatchObject({
      transactionId: refund.id, decision: { status: "Approved", reviewer: "Jordan Lee" },
      execution: { status: "Test cash payout reported", reportedBy: "Robin Davis" },
    });
  });

  it("exposes hosted discount review only to signed-in staff through presenter ingress", async () => {
    const users = demoAccounts.map(account => {
      const salt = randomBytes(16);
      return { ...account, salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") } as Employee;
    });
    const server = app(undefined, users, undefined, undefined, undefined, true, true);
    const unlocked = await signIn(server, "maya");
    const list = action({ operation: "list" });
    expect(unlocked.user.demoDiscountEnabled).toBeUndefined();
    expect((await unlocked.request(list)).status).toBe(404);
    const presenterEmail = "presenter@example.test";
    const protectedApp = createTeamWorkspace(server.store, users, origin, { hostedDemo: true, presenterEmail });
    const makeSession = (email: string) => ({
      request(command: unknown, cookie = "", { sessionVersion = "" } = {}) {
        return protectedApp.handle(new Request(origin + "/api/merchant", {
          method: "POST", headers: { Origin: origin, Host: new URL(origin).host, Cookie: cookie,
            "X-ChangeGate-Session": sessionVersion, "Content-Type": "application/json",
            "x-changegate-access-email": email, "x-changegate-access-subject": "verified-test-subject" },
          body: JSON.stringify(command),
        }));
      },
    });
    const presenter = makeSession(presenterEmail);
    const guest = makeSession("guest@example.test");
    const maya = await signIn(presenter, "maya");
    expect(maya.user).toMatchObject({ demoDiscountEnabled: true, syntheticOnly: true });
    expect((await presenter.request(list)).status).toBe(401);
    expect((await guest.request(list, maya.key, { sessionVersion: maya.user.sessionVersion })).status).toBe(403);
    const reference = "DEMO-SALE-" + randomUUID();
    const started = await maya.send<DiscountSale>(action({ operation: "start", reference, original: "100.00", discount: "30.00" }));
    const jordan = await signIn(presenter, "jordan");
    expect(await jordan.send(list)).toEqual([started]);
    await jordan.send(action({ operation: "decide", reference, revision: 1, decision: "Approved", password }));
    const sale = await maya.send<DiscountSale>(action({ operation: "finish", reference, revision: 1, choice: "discounted" }));
    expect(sale.completion?.subtotalCents).toBe(7000);
  });

  it.each(["discounted", "full price", "cancel"] as const)("records the %s outcome once and preserves the decision", async choice => {
    const users = [...demoAccounts, { ...demoAccounts[2]!, username: "shop-owner", name: "Harbor Owner", role: "owner" }]
      .map(account => {
        const salt = randomBytes(16);
        return { ...account, salt: salt.toString("hex"), passwordHash: scryptSync(password,salt,32).toString("hex") } as Employee;
      });
    const server = app(undefined, users, undefined, undefined, undefined, true);
    const [maya, jordan, owner, alex] = await Promise.all(["maya", "jordan", "shop-owner", "alex"].map(user => signIn(server, user)));
    const reference = "DEMO-SALE-" + randomUUID();
    const start = action({ operation: "start", reference, original: "100.00", discount: "30.00" });
    const open = action({ operation: "open", reference });
    const finish = action({ operation: "finish", reference, revision: 1, choice });
    const decision = action({ operation: "decide", reference, revision: 1,
      decision: choice === "discounted" ? "Approved" : "Rejected", password });
    const pending = await maya!.send<DiscountSale>(start);
    expect(await maya!.send<DiscountSale>(start)).toEqual(pending);
    expect(await jordan!.send<DiscountSale[]>(action({ operation: "list" }))).toEqual([pending]);
    expect((await maya!.request(finish)).status).toBe(409);
    expect((await maya!.request(decision)).status).toBe(403);
    expect((await alex!.request(open)).status).toBe(404);
    expect((await maya!.request({ action: "openDemoSale", reference })).status).toBe(404);
    await jordan!.send<DiscountSale>(decision);
    expect((await owner!.request(decision)).status).toBe(409);
    const expected = choice === "discounted" ? 7000 : choice === "full price" ? 10000 : null;
    if (choice === "discounted") {
      const secondReference = "DEMO-SALE-" + randomUUID();
      await maya!.send(action({ operation: "start", reference: secondReference, original: "100.00", discount: "30.00" }));
      await jordan!.send(action({ operation: "decide", reference: secondReference, revision: 1, decision: "Approved", password }));
      const revised = await maya!.send<DiscountSale>(action({ operation: "revise", reference: secondReference, revision: 1,
        original: "110.00", discount: "35.00" }));
      expect(revised.proposals).toHaveLength(2);
      expect(revised.proposals[1]!.decision).toBeUndefined();
      expect((await maya!.request(action({ operation: "finish", reference: secondReference, revision: 1, choice }))).status).toBe(409);
      expect((await maya!.request(action({ operation: "finish", reference: secondReference, revision: 2, choice }))).status).toBe(409);
      expect((await jordan!.request(action({ operation: "decide", reference: secondReference, revision: 1,
        decision: "Approved", password }))).status).toBe(409);
    } else {
      expect((await maya!.request(action({ operation: "finish", reference, revision: 1, choice: "discounted" }))).status).toBe(409);
    }
    const outcomes = await Promise.all([maya!.send<DiscountSale>(finish), maya!.send<DiscountSale>(finish)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]?.completion?.subtotalCents).toBe(expected);
    server.stop();
    const restarted = app(server.path, users, undefined, undefined, undefined, true);
    const opened = await Promise.all(["maya", "jordan", "shop-owner"].map(async name =>
      (await signIn(restarted,name)).send<DiscountSale>(open)));
    expect(opened).toEqual([outcomes[0], outcomes[0], outcomes[0]]);
    const ownerSession = await signIn(restarted,"shop-owner");
    const groups = shiftGroups(await ownerSession.send<ShiftOverview>({ action: "shiftOverview", manual: true }), "Harbor Bar");
    expect(groups.sales.map(row => row.amountCents)).toEqual(expected === null ? [] : [expected]);
    expect(groups.discounts.map(row => row.amountCents)).toEqual(choice === "discounted" ? [3000] : []);
    expect(groups.refunds).toEqual([]);
    expect(groups.payouts).toEqual([]);
  });
});

describe("authenticated synthetic shift", () => {
  it("freezes a blind cash count and reuses one variance case across restart", async () => {
    const users = roster.map(employee => ({ ...employee, role: employee.username === "maya" ? "cashier" as const : "manager" as const }));
    const server = app(undefined, users, undefined, undefined, undefined, true, true);
    const cashier = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const otherMerchant = await signIn(server, "alex");
    const id = randomUUID();
    const open = { action: "openCashDrawer", id, cents: 10000 };
    const close = { action: "closeCashDrawer", id, cents: 16300 };
    const read = { action: "cashDrawers", id };
    expect(await cashier.send<CashDrawerView>({ action: "cashDrawers" })).toMatchObject({ drawer: null });
    expect(await cashier.send<CashDrawerView>(open)).toMatchObject({ activeId: id, drawer: { report: null } });
    expect(await cashier.send<CashDrawerView>(open)).toMatchObject({ activeId: id });
    const sale = { action: "recordDemoSale", submissionId: randomUUID(), amount: "80.00", tender: "Cash" };
    const savedSale = await cashier.send<{ reference: string }>(sale);
    expect(await cashier.send(sale)).toEqual(savedSale);
    await cashier.send({ ...sale, submissionId: randomUUID(), amount: "25.00", tender: "Electronic" });
    const refund = await cashier.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference: savedSale.reference, amount: "12.00", currency: "USD", reason: "Test cash payout" } });
    const payout = { action: "reportCashPayout", id: refund.id };
    await cashier.send(payout);
    await cashier.send(payout);
    const held = await cashier.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference: savedSale.reference, amount: "50.00", currency: "USD", reason: "Held in this drawer" } });
    const heldPayout = { action: "reportCashPayout", id: held.id };
    expect((await cashier.request(heldPayout)).status).toBe(409);
    await supervisor.send({ action: "decideRefundRequest", id: held.id, decision: "Approved", password });
    const movement = { action: "recordDrawerMovement", id, entryId: randomUUID(), kind: "addition", cents: 200, note: "Change added" };
    await cashier.send(movement);
    await cashier.send(movement);
    expect((await cashier.request({ ...movement, kind: "removal" })).status).toBe(409);
    await cashier.send({ ...movement, entryId: randomUUID(), kind: "removal", note: "Change removed" });
    expect((await otherMerchant.request(read)).status).toBe(404);
    expect(await supervisor.send<CashDrawerView>(read)).toMatchObject({ drawer: { report: null } });
    const closed = await cashier.send<CashDrawerView>(close);
    expect(closed.drawer?.report).toMatchObject({ expected: 16800, variance: -500, firstCount: { cents: 16300, actor: "Maya Chen" } });
    expect(closed.drawer?.report?.entries.map(({ cents }) => cents)).toEqual([8000, -1200, 200, -200]);
    expect(await cashier.send(close)).toEqual(closed);
    await cashier.send({ ...sale, submissionId: randomUUID(), amount: "31.00", tender: "Electronic" });
    expect(await cashier.send(read)).toEqual(closed);
    const review = { action: "openDrawerCase", id };
    const cases = await Promise.all([supervisor.send<CashDrawerView>(review), supervisor.send<CashDrawerView>(review)]);
    const caseId = cases[0].drawer?.report?.caseId;
    expect(caseId).toBeTruthy();
    expect(cases[1].drawer?.report?.caseId).toBe(caseId);
    expect((await cashier.request({ action: "note", id: caseId, revision: 1, note: "Unauthorized review" })).status).toBe(403);
    await supervisor.send({ action: "recordDrawerFollowUp", id, entryId: randomUUID(), cents: 16400, note: "Recount recorded" });
    await supervisor.send({ action: "record", id: caseId, revision: 1, finding: "Recount reviewed", nextAction: "Reconcile cash log", status: "Investigating" });
    await supervisor.send({ action: "resolve", id: caseId, revision: 2, drawerDisposition: "Closed with difference unexplained" });
    server.stop();
    const reopened = app(server.path, users, undefined, undefined, undefined, true, true);
    const reviewer = await signIn(reopened, "jordan");
    const result = await reviewer.send<CashDrawerView>(review);
    expect(result.drawer?.report).toMatchObject({ caseId, expected: 16800, variance: -500,
      firstCount: { cents: 16300 }, followUps: [{ cents: 16400, actor: "Jordan Lee" }] });
    const workspace = await reviewer.send<TeamWorkspaceView>({ action: "workspace", id: caseId });
    expect(workspace.detail).toMatchObject({ drawerId: id, case: { id: caseId, status: "Resolved" } });
    expect(workspace.detail?.history.at(-1)).toMatchObject({ kind: "Resolved", actor: "Jordan Lee" });
  });

  it("keeps weekly shortages and overages separate when a supervisor resolves a drawer case", async () => {
    let now = "2026-11-09T04:59:59.000Z";
    const users = roster.map(employee => ({ ...employee, role: employee.username === "maya" ? "cashier" as const : "manager" as const }));
    const openApp = (path?: string) => app(path, users, () => now, undefined, undefined, true, true);
    const server = openApp();
    const cashier = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const outsider = await signIn(server, "alex");
    const shift = async (cents?: number) => {
      const id = randomUUID();
      await cashier.send({ action: "openCashDrawer", id, cents: 10000 });
      if (cents !== undefined) await cashier.send({ action: "closeCashDrawer", id, cents });
      return id;
    };
    await shift(9000);
    now = "2026-11-09T05:00:00.000Z";
    const first = await shift(9500);
    now = "2026-11-10T22:00:00.000Z";
    const second = await shift(9300);
    now = "2026-11-11T22:00:00.000Z";
    const over = await shift(10400);
    now = "2026-11-12T22:00:00.000Z";
    await shift(10000);
    now = "2026-11-13T22:00:00.000Z";
    await shift();
    async function openReview(id: string) {
      const result = await supervisor.send<CashDrawerView>({ action: "openDrawerCase", id });
      return result.drawer!.report!.caseId!;
    }
    const [firstCase, , overCase] = await Promise.all([openReview(first), openReview(second), openReview(over)]);
    const read = { action: "weeklyCashReview", week: "2026-11-12" };
    expect((await cashier.request(read)).status).toBe(403);
    expect((await outsider.request(read)).status).toBe(404);
    expect((await supervisor.send<CashWeek>({ ...read, location: "Harbor Bar" })).rows).toEqual([]);
    const initial = await supervisor.send<CashWeek>({ ...read, location: "Harbor Fuel" });
    expect(initial).toMatchObject({ start: "2026-11-09", end: "2026-11-15", timeZone: "America/New_York" });
    const before = cashWeekGroups(initial.rows);
    expect(Object.values(before).map(rows => rows.length)).toEqual([4, 2, 1, 1, 3, 1]);
    expect([originalVarianceTotal(before.short), originalVarianceTotal(before.over)]).toEqual([1200, 400]);
    async function document(id: string) {
      await supervisor.send({ action: "record", id, revision: 1, finding: "Reviewed the drawer count",
        nextAction: "Document the disposition", status: "Investigating" });
    }
    await document(firstCase);
    await supervisor.send({ action: "resolve", id: firstCase, revision: 2, drawerDisposition: "Closed with difference unexplained" });
    let rows = (await supervisor.send<CashWeek>(read)).rows;
    expect(cashWeekGroups(rows).unresolved).toHaveLength(2);
    expect(originalVarianceTotal(cashWeekGroups(rows).short)).toBe(1200);
    await document(overCase);
    const correction = { action: "resolve", id: overCase, revision: 2, drawerDisposition: "Recount corrected the count" };
    expect((await supervisor.request(correction)).status).toBe(422);
    await supervisor.send({ action: "recordDrawerFollowUp", id: over, cents: 10000, entryId: randomUUID(), note: "Recount matched expected" });
    await supervisor.send(correction);
    await cashier.send({ action: "closeCashDrawer", id: first, cents: 10000 });
    server.stop();
    const restarted = openApp(server.path);
    rows = (await (await signIn(restarted, "jordan")).send<CashWeek>(read)).rows;
    const after = cashWeekGroups(rows);
    expect(Object.values(after).map(items => items.length)).toEqual([4, 2, 1, 1, 1, 1]);
    expect([originalVarianceTotal(after.short), originalVarianceTotal(after.over)]).toEqual([1200, 400]);
    expect(rows.find(row => row.id === first)?.close).toMatchObject({
      firstCount: { cents: 9500 }, review: { reviewer: "Jordan Lee", disposition: "Closed with difference unexplained" },
    });
    expect(rows.find(row => row.id === over)?.close).toMatchObject({
      firstCount: { cents: 10400 }, recount: { cents: 10000 }, review: { disposition: "Recount corrected the count" },
    });
  });
  it("uses the HTTPS staging session boundary and accepts only synthetic writes on Railway", async () => {
    const demoOrigin = "https://changegate-demo.up.railway.app";
    const host = new URL(demoOrigin).host;
    const users = roster.map(employee => ({ ...employee, role: "cashier" as const }));
    const store = new TeamStore(":memory:", undefined, true);
    stores.add(store);
    const app = createTeamWorkspace(store, users, demoOrigin, { staging: true, hostedDemo: true });
    const request = (body: object, extra: Record<string,string> = {}) => app.handle(new Request(demoOrigin+"/api/merchant", {
      method: "POST", body: JSON.stringify(body), headers: { Host:host, Origin:demoOrigin, "Content-Type":"application/json",
        "X-Forwarded-Host":host, "X-Forwarded-Proto":"https", "X-Real-IP":"192.0.2.1", ...extra },
    }));
    const login = { action:"signIn", username:"maya", password };
    expect((await request(login, { "X-Forwarded-Proto":"http" })).status).toBe(403);
    expect((await request(login, { Origin:"https://unrelated.example" })).status).toBe(403);
    expect((await request({action:"demoShift"})).status).toBe(401);
    const signed = await request(login);
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-changegate_team_session=.*; HttpOnly; SameSite=Strict; Path=\/;.*; Secure$/);
    const session = await signed.json() as TeamSession;
    const credentials = { Cookie:cookie.split(";")[0]!, "X-ChangeGate-Session":session.sessionVersion };
    expect(session).toMatchObject({ syntheticOnly:true, demoShift:true, paypalConnected:false });
    expect((await request({action:"importCsv",text:"reference,amount,currency",mapping:{reference:0,amount:1,currency:2}}, credentials)).status).toBe(404);
    expect((await request({action:"lookupOriginalSale",reference:"sandbox-sale",source:"square"}, credentials)).status).toBe(404);
    expect((await request({action:"createRefundRequest",submissionId:randomUUID(),terms:{reference:"TEST-SALE-CASH",amount:"50.00",currency:"USD",reason:"Test"}}, credentials)).status).toBe(404);
    expect((await request({action:"startDemoShift",seed:"harbor-evening"}, credentials)).status).toBe(200);
  });

  it("replays the same scope, decisions and holds without touching other records", async () => {
    const users = demoAccounts.map(account => {
      const salt = randomBytes(16);
      return { ...account, role: account.role as Employee["role"], salt: salt.toString("hex"),
        passwordHash: scryptSync(password, salt, 32).toString("hex") } as Employee;
    });
    const server = app(undefined, users, undefined, undefined, undefined, true);
    const [maya, robin, jordan, backup, alex] = await Promise.all(users.map(user => signIn(server,user.username)));
    type View = { state: DemoState; inbox: { requestId: string; phase: number }[] };
    const seed = "harbor-evening";
    let { state } = await maya!.send<View>({ action: "startDemoShift", seed });
    const otherTerms = { reference: "TEST-SALE-ELECTRONIC", currency: "USD", amount: "5.00", reason: "Unrelated fixture" };
    const other = await alex!.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(), terms: otherTerms });
    const sameMerchant = await maya!.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(), terms: otherTerms });
    const advance = async () => {
      const result = await maya!.send<View>({ action: "nextDemoEvent", runId: state.runId, step: state.step });
      state = result.state;
    };
    const submit = (cashier: typeof maya) => cashier!.send<RefundRequest>({ action: "createRefundRequest", submissionId: randomUUID(),
      demoRun: state.runId, terms: { reference: state.event.sale!.reference, amount: state.event.refund!.amount,
        reason: state.event.refund!.reason, currency: "USD" } });
    const approve = (id: string) => ({ action: "decideRefundRequest", id, decision: "Approved", password });
    async function play(verifyRoles: boolean) {
      const events = [state.event];
      const routes: string[] = [];
      const ids: string[] = [];
      while (!state.finished) {
        if (state.event.refund) {
          const cashier = state.event.refund.cashier === "maya" ? maya : robin;
          const lookup = await cashier!.send<{ sale: object }>({ action: "lookupOriginalSale", reference: state.event.sale!.reference });
          expect(lookup.sale).toEqual(state.event.sale);
          const result = await submit(cashier);
          expect((await submit(cashier)).id).toBe(result.id);
          const check = checks(result);
          routes.push(check.route);
          ids.push(result.id);
          if (state.step === 6) {
            expect(check.monitoring).toMatchObject({ cashierWatchCount: 3, registerWatchCount: 3 });
            expect(check.monitoring?.reasons.join(" ")).toMatch(/across registers.*across cashiers/);
          }
          if (state.step === 2 && verifyRoles) {
            expect(check.cumulativeCents).toBe(5000);
            expect((await jordan!.send<View>({ action: "demoShift" })).inbox).toEqual([{ requestId: result.id, phase: 0 }]);
            expect((await backup!.send<View>({ action: "demoShift" })).inbox).toEqual([]);
            expect((await maya!.request(approve(result.id))).status).toBe(403);
            expect((await alex!.request(approve(result.id))).status).toBe(404);
            expect((await alex!.request({ action: "openRefundRequest", id: result.id })).status).toBe(404);
            expect((await alex!.request({ action: "demoShift" })).status).toBe(404);
            const receipt = requestReceipt(await jordan!.send<RefundRequest>(approve(result.id)));
            expect(receipt.decision).toMatchObject({ status: "Approved" });
            expect(receipt.execution).toMatchObject({ status: "Not submitted", attempt: null, providerResponse: null });
          }
        }
        await advance();
        events.push(state.event);
      }
      expect((await backup!.send<View>({ action: "demoShift" })).inbox).toContainEqual({ requestId: ids[4], phase: 1 });
      return { events, routes, ids };
    }
    const first = await play(true);
    const overview = await jordan!.send<import("../src/merchant-team/shift-overview").ShiftOverview>({ action: "shiftOverview" });
    expect(overview.sales).toHaveLength(2);
    expect(overview.sales.filter(sale => sale.discountCents > 0)).toHaveLength(1);
    expect(overview.refunds).toHaveLength(5);
    expect(overview.refunds.filter(row => row.awaitingApproval).map(row => row.id)).toEqual([first.ids[4]]);
    expect(overview.refunds.filter(row => row.awaitingSubmission).map(row => row.id)).toEqual([first.ids[0]]);
    expect(overview.refunds.every(row => row.confirmedPayoutCents === null)).toBe(true);
    expect((await alex!.request({ action: "shiftOverview" })).status).toBe(404);
    expect(first.events).toEqual(generateDemoEvents(seed));
    expect(first.routes).toEqual(["manager", "routine", "routine", "routine", "manager"]);
    const reviewer = users[2]!;
    const firstHeld = await jordan!.send<RefundRequest>({ action: "openRefundRequest", id: first.ids[4] });
    expect(checks(firstHeld)).toMatchObject({ cumulativeCents: 3800, thresholdCents: 5000 });
    const preview = { action: "previewRefundThreshold", location: "Harbor Fuel", shift: "Demo shift", thresholdCents: 10000 };
    const report = await jordan!.send<import("../src/merchant-team/refund-threshold-preview").ThresholdPreview>(preview);
    expect(report).toMatchObject({ currentCents: 5000, proposedCents: 10000, added: 0, removed: 0 });
    expect(report.rows.find(row => row.id === firstHeld.id)).toMatchObject({
      current: "Supervisor review", proposed: "Supervisor review",
      reason: expect.stringMatching(/cashier across registers.*register across cashiers/),
    });
    expect(await jordan!.send<RefundRequest>({ action: "openRefundRequest", id: firstHeld.id })).toEqual(firstHeld);
    expect((await maya!.request(preview)).status).toBe(403);
    expect(await alex!.send(preview)).toMatchObject({ rows: [], added: 0, removed: 0 });
    const activity = firstHeld.watchActivity;
    expect(activity?.cashier.map(({ id, occurredAt, register }) => [id, occurredAt, register])).toEqual([
      [first.ids[1], first.events[3]!.at, "Register 1"],
      [first.ids[3], first.events[5]!.at, "Bar 1"],
      [first.ids[4], first.events[6]!.at, "Register 1"],
    ]);
    expect(activity?.register.map(({ id, occurredAt }) => [id, occurredAt])).toEqual([
      [first.ids[1], first.events[3]!.at],
      [first.ids[2], first.events[4]!.at],
      [first.ids[4], first.events[6]!.at],
    ]);
    expect((await maya!.send<RefundRequest>({ action: "openRefundRequest", id: firstHeld.id })).watchActivity).toBeUndefined();
    expect((await alex!.request({ action: "openRefundRequest", id: firstHeld.id })).status).toBe(404);
    vi.stubEnv("CHANGEGATE_MONITOR_AI_KEY", undefined);
    vi.stubEnv("CHANGEGATE_MONITOR_AI_MODEL", undefined);
    try {
      expect(demoExplanation(server.store.alerts, reviewer, firstHeld)).toEqual({ status:"unavailable" });
      vi.stubEnv("CHANGEGATE_MONITOR_AI_KEY", "test-only");
      vi.stubEnv("CHANGEGATE_MONITOR_AI_MODEL", "test-model");
      const transport = vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body));
        expect(payload).toMatchObject({ model:"test-model", store:false });
        expect(JSON.parse(payload.input)).toEqual({ windowMinutes:15, threshold:3, rules:[
          { label:"Unusual refunds by the same cashier across registers", count:3 },
          { label:"Unusual refunds at the same register across cashiers", count:3 },
        ] });
        return Response.json({ status:"completed", model:"test-model-version", usage:{input_tokens:52,output_tokens:18},
          output:[{content:[{type:"output_text",text:JSON.stringify({summary:"Both scopes reached three unusual refunds in 15 minutes."})}]}] });
      });
      vi.stubGlobal("fetch", transport);
      expect(demoExplanation(server.store.alerts, reviewer, firstHeld)).toEqual({ status:"pending" });
      expect(demoExplanation(server.store.alerts, reviewer, firstHeld)).toEqual({ status:"pending" });
      await vi.waitFor(() => expect(demoExplanation(server.store.alerts, reviewer, firstHeld)).toMatchObject({
        status:"complete", summary:"Both scopes reached three unusual refunds in 15 minutes.", model:"test-model-version", usage:{input:52,output:18},
      }));
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    const lastRun = state.runId;
    ({ state } = await maya!.send<View>({ action: "replayDemoShift", runId: lastRun }));
    expect(state.runId).not.toBe(lastRun);
    const resetOverview = await jordan!.send<import("../src/merchant-team/shift-overview").ShiftOverview>({ action: "shiftOverview" });
    expect(resetOverview.sales).toHaveLength(1);
    expect(resetOverview.refunds).toEqual([]);
    expect(await maya!.send<RefundRequest[]>({ action: "listRefundRequests" })).toEqual([sameMerchant]);
    expect(await alex!.send<RefundRequest[]>({ action: "listRefundRequests" })).toEqual([other]);
    const second = await play(false);
    expect(second.events).toEqual(first.events);
    expect(second.routes).toEqual(first.routes);
    const secondHeld = await jordan!.send<RefundRequest>({ action: "openRefundRequest", id: second.ids[4] });
    vi.stubEnv("CHANGEGATE_MONITOR_AI_KEY", "test-only");
    vi.stubEnv("CHANGEGATE_MONITOR_AI_MODEL", "test-model");
    const timeout = vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); });
    vi.stubGlobal("fetch", timeout);
    try {
      expect(demoExplanation(server.store.alerts, reviewer, secondHeld)).toEqual({status:"pending"});
      await vi.waitFor(() => expect(demoExplanation(server.store.alerts, reviewer, secondHeld)).toEqual({status:"unavailable"}));
      expect(demoExplanation(server.store.alerts, reviewer, secondHeld)).toEqual({status:"unavailable"});
      expect(timeout).toHaveBeenCalledTimes(1);
      const approved = await jordan!.send<RefundRequest>(approve(secondHeld.id));
      expect(requestReceipt(approved)).toMatchObject({ decision:{status:"Approved"},execution:{status:"Not submitted"} });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    const replayHeld = { action: "replayHeldDemoRefund", runId: state.runId };
    expect((await alex!.request(replayHeld)).status).toBe(404);
    const heldOverview = await jordan!.send<import("../src/merchant-team/shift-overview").ShiftOverview>(replayHeld);
    expect(heldOverview).toMatchObject({ seed, sales: overview.sales });
    expect(heldOverview.runId).not.toBe(state.runId);
    expect(heldOverview.refunds).toHaveLength(5);
    const held = heldOverview.refunds.find(refund => refund.amountCents === 3800)!;
    expect(held).toMatchObject({ location: "Harbor Fuel", awaitingApproval: true, awaitingSubmission: false, confirmedPayoutCents: null });
    expect(heldOverview.refunds.filter(refund => refund.awaitingApproval)).toHaveLength(2);
    expect(heldOverview.refunds.every(refund => !refund.awaitingSubmission && refund.confirmedPayoutCents === null)).toBe(true);
    const final = await jordan!.send<View>({ action: "demoShift" });
    expect(final.state).toMatchObject({ requestId: held.id, finished: false, event: generateDemoEvents(seed)[6] });
    expect(final.inbox).toContainEqual({ requestId: held.id, phase: 0 });
    expect((await backup!.send<View>({ action: "demoShift" })).inbox).not.toContainEqual({ requestId: held.id, phase: 1 });
    expect((await jordan!.request(replayHeld)).status).toBe(409);
    const decisions = await Promise.all([
      jordan!.request({ action: "decideRefundRequest", id: held.id, decision: "Rejected", password }),
      backup!.request({ action: "decideRefundRequest", id: held.id, decision: "Approved", password }),
    ]);
    expect(decisions.map(result => result.status).sort()).toEqual([200, 409]);
    const won = decisions[0]!.ok ? { decision: "Rejected", actor: "Jordan Lee", reviewer: jordan! }
      : { decision: "Approved", actor: "Backup Supervisor", reviewer: backup! };
    const decisionEvents = async () => (await jordan!.send<RefundRequest>({ action: "openRefundRequest", id: held.id }))
      .events.filter(event => event.kind === "Decision recorded");
    const recorded = await decisionEvents();
    expect(recorded).toEqual([{ kind: "Decision recorded", decision: won.decision, actor: won.actor,
      occurredAt: final.state.event.at }]);
    expect((await won.reviewer.request({ action: "decideRefundRequest", id: held.id, decision: won.decision, password })).status).toBe(200);
    expect(await decisionEvents()).toEqual(recorded);
    expect((await jordan!.request({ action: "openRefundRequest", id: secondHeld.id })).status).toBe(404);
    expect((await maya!.send<RefundRequest[]>({ action: "listRefundRequests" })).map(row => row.id)).toContain(sameMerchant.id);
    expect(await alex!.send<RefundRequest[]>({ action: "listRefundRequests" })).toEqual([other]);
  });
});

describe("cashier-recorded demo sales", () => {
  it("reserves an approved partial refund, blocks an overage and retains both after restart and seeded replay", async () => {
    const users = roster.map(employee => ({ ...employee, role: employee.username === "maya" ? "cashier" as const : "manager" as const }));
    let server = app(undefined, users, undefined, undefined, undefined, true);
    const [maya, jordan, alex] = await Promise.all(users.map(user => signIn(server, user.username)));
    const command = { action: "recordDemoSale", submissionId: randomUUID(), amount: "75.00", tender: "Electronic" };
    type DemoSale = import("../src/merchant-team/demo-sales").DemoSale;
    expect((await maya!.request({ ...command, merchantId: "ridge" })).status).toBe(400);
    expect((await jordan!.request(command)).status).toBe(403);
    const [sale, duplicate] = await Promise.all([maya!.send<DemoSale>(command), maya!.send<DemoSale>(command)]);
    expect(sale).toEqual(duplicate);
    expect(sale).toMatchObject({ originalCents: 7500, cashier: "Maya Chen", location: "Harbor Fuel", register: "Register 1", recordedDemo: true });
    expect((await maya!.request({ ...command, amount: "76.00" })).status).toBe(409);
    const reference = sale.reference;
    const original = { action: "openDemoSale", reference };
    expect((await alex!.request(original)).status).toBe(404);
    expect((await alex!.request({ action: "lookupOriginalSale", reference })).status).toBe(404);
    const request = (amount: string) => ({ action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference, amount, currency: "USD", reason: "Partial demo refund" } });
    expect((await alex!.request(request("5.00"))).status).toBe(404);
    const held = await maya!.send<RefundRequest>(request("52.00"));
    expect(checks(held)).toMatchObject({ route: "manager", thresholdCents: 5000, balanceCents: 7500 });
    expect(checks(held).explanation).toContain("$50.00 store threshold");
    const approved = await jordan!.send<RefundRequest>({ action: "decideRefundRequest", id: held.id, decision: "Approved", password });
    expect(requestReceipt(approved)).toMatchObject({ decision: { status: "Approved", reviewer: "Jordan Lee" }, execution: { status: "Not submitted" } });
    const blocked = await maya!.send<RefundRequest>(request("24.00"));
    expect(checks(blocked)).toMatchObject({ route: "over-balance", balanceCents: 2300, reservedCents: 5200 });
    expect(checks(blocked).explanation).toContain("Only $23.00 remains refundable");
    const manual = { action: "shiftOverview", manual: true };
    type Overview = import("../src/merchant-team/shift-overview").ShiftOverview;
    const beforeRestart = await maya!.send<Overview>(manual);
    expect(beforeRestart.sales).toHaveLength(1);
    expect(beforeRestart.refunds.find(row => row.id === held.id)).toMatchObject({ awaitingSubmission: true, confirmedPayoutCents: null });
    const dbPath = server.path;
    server.stop();
    server = app(dbPath, users, undefined, undefined, undefined, true);
    const resumed = await signIn(server, "maya");
    expect(await resumed.send(manual)).toEqual(beforeRestart);
    expect(await resumed.send({ action: "lookupOriginalSale", reference })).toMatchObject({ sale, reservedCents: 5200, paidCents: 0, balanceCents: 2300 });
    const seeded = await resumed.send<{ state: DemoState }>({ action: "startDemoShift", seed: "harbor-evening" });
    await resumed.send({ action: "replayDemoShift", runId: seeded.state.runId });
    expect(await resumed.send(manual)).toEqual(beforeRestart);
  });
});

describe("Square Sandbox refunds", () => {
  const users: Employee[] = roster.map(employee => ({ ...employee, role: "manager" }));
  const config = { teamMerchantId: "harbor", merchantId: "square-seller", locationId: "square-location", accessToken: "fixture-key" };
  const terms = { source: "square", reference: "test-square-payment", amount: "50.00", currency: "USD", reason: "Test return" };
  const refund = { id: "test-square-refund", payment_id: terms.reference, location_id: config.locationId,
    amount_money: { amount: 5000, currency: "USD" }, status: "COMPLETED" };

  function provider() {
    const posts: unknown[] = [];
    const ledger = new Map<string, typeof refund>();
    const settings = { merchant: config.merchantId, location: config.locationId, status: "COMPLETED", currency: "USD",
      loseResponse: false, visible: true, readback: refund, total: 12000, waitForPost: Promise.resolve(),
      createdAt: new Date().toISOString(), refundIds: [] as string[], priorRefundStatus: "FAILED",
      failMerchantRead: 0, denyRefund: false, rejectionCode: "INSUFFICIENT_PERMISSIONS_FOR_REFUND", beforePaymentRead: async () => {},
      beforeMerchantRead: async (_read: number) => { void _read; }, afterPost: async (_count: number) => { void _count; } };
    let merchantReads = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://connect.squareupsandbox.com");
      if (url.pathname === "/v2/merchants/me") {
        const read = ++merchantReads;
        await settings.beforeMerchantRead(read);
        return read === settings.failMerchantRead ? new Response(null, { status: 503 }) :
          Response.json({ merchant: { id: settings.merchant } });
      }
      if (url.pathname === "/v2/payments/" + terms.reference) {
        await settings.beforePaymentRead();
        return Response.json({ payment: { id: terms.reference, location_id: settings.location, status: settings.status,
          source_type: "CARD", created_at: settings.createdAt, total_money: { amount: settings.total, currency: settings.currency },
          refund_ids: [...settings.refundIds, ...[...ledger.values()].map(row => row.id)],
          refunded_money: { amount: settings.readback.status === "COMPLETED" ? ledger.size * 5000 : 0, currency: "USD" } } });
      }
      if (url.pathname === "/v2/refunds" && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { idempotency_key: string };
        posts.push(body);
        if (settings.denyRefund) return Response.json({ errors: [{ code: settings.rejectionCode }] }, { status: 400 });
        await settings.waitForPost;
        ledger.set(body.idempotency_key, refund);
        await settings.afterPost(posts.length);
        if (settings.loseResponse) throw new Error("lost provider response");
        return Response.json({ refund: { ...refund, status: "PENDING" } });
      }
      if (url.pathname === "/v2/refunds/" + refund.id) {
        return settings.visible ? Response.json({ refund: settings.readback }) : new Response(null, { status: 503 });
      }
      if (url.pathname === "/v2/refunds/earlier-refund") {
        return Response.json({ refund: { ...refund, id: "earlier-refund", status: settings.priorRefundStatus } });
      }
      return new Response(null, { status: 404 });
    };
    return { square: new SquareSandbox(config, transport), settings, posts, ledger, transport };
  }
  async function appProcess(path: string, transport: typeof fetch) {
    const child = fork(fileURLToPath(new URL("./fixtures/square-process.mjs", import.meta.url)), {
      execArgv: [],
    });
    children.add(child);
    let sequence = 0;
    const pending = new Map<number, (result: Response) => void>();
    const ready = Promise.withResolvers<number>();
    child.on("message", async message => {
      const reply = message as { type: string; pid: number; id: number; url: string; method: string;
        body?: string; status: number; headers: [string, string][] };
      if (reply.type === "ready") return ready.resolve(reply.pid);
      if (reply.type === "provider") {
        try {
          const outcome = await transport(reply.url, { method: reply.method, ...(reply.body && { body: reply.body }) });
          if (child.connected) child.send({ type: "providerReply", id: reply.id, status: outcome.status, body: await outcome.text() });
        } catch {
          if (child.connected) child.send({ type: "providerReply", id: reply.id, error: true });
        }
        return;
      }
      pending.get(reply.id)?.(new Response(reply.body, { status: reply.status, headers: reply.headers }));
      pending.delete(reply.id);
    });
    child.once("exit", () => {
      children.delete(child);
      ready.reject(new Error("Square test process exited before startup"));
      for (const complete of pending.values()) complete(new Response(null, { status: 503 }));
    });
    const staff = users.map(user => user.username === "maya" ? { ...user, role: "cashier" } : user);
    child.send({ type: "init", path, origin, users: staff, config });
    return {
      pid: await ready.promise,
      async stop() {
        const exited = once(child, "exit");
        child.disconnect();
        await exited;
      },
      request(command: unknown, cookie = "", { sessionVersion = "" } = {}) {
        return new Promise<Response>(resolve => {
          const id = ++sequence;
          pending.set(id, resolve);
          child.send({ type: "request", id, command, cookie, sessionVersion });
        });
      },
    };
  }

  function processDatabase() {
    const folder = mkdtempSync(join(tmpdir(), "changegate-square-process-"));
    folders.push(folder);
    return join(folder, "merchant.sqlite");
  }

  const submit = (overrides = {}) => ({ action: "createRefundRequest", submissionId: randomUUID(), terms: { ...terms, ...overrides } });

  it("holds at the threshold, denies self-review and tenant bypass, and resumes one lost attempt after restart", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const outsider = await signIn(server, "alex");
    const request = await cashier.send<RefundRequest>(submit());
    expect(requestStatus(request)).toBe("Needs manager decision");
    const execute = { action: "executeElectronicRefund", id: request.id };
    const approval = { action: "decideRefundRequest", id: request.id, decision: "Approved", password };
    expect((await cashier.request(execute)).status).toBe(409);
    expect((await cashier.request(approval)).status).toBe(403);
    expect((await outsider.request(execute)).status).toBe(404);
    expect((await outsider.request({ action: "lookupOriginalSale", source: "square", reference: terms.reference })).status).toBe(503);
    expect(mock.posts).toEqual([]);
    expect(mock.ledger.size).toBe(0);
    await manager.send(approval);
    mock.settings.loseResponse = true;
    const uncertain = await cashier.send<RefundRequest>(execute);
    expect(requestReceipt(uncertain).execution.status).toBe("Outcome unconfirmed");
    expect(requestReceipt(uncertain).verification.status).toBe("Not run");
    expect(mock.ledger.size).toBe(1);
    server.stop();
    mock.settings.loseResponse = false;
    const restarted = app(server.path, users, undefined, mock.square);
    const operator = await signIn(restarted, "maya");
    const completed = await operator.send<RefundRequest>(execute);
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[0]).toEqual({ idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/),
      payment_id: terms.reference, amount_money: { amount: 5000, currency: "USD" } });
    expect(mock.posts[0]).toEqual(mock.posts[1]);
    expect(mock.ledger.size).toBe(1);
    const receipt = requestReceipt(completed);
    expect(receipt.decision).toMatchObject({ status: "Approved", reviewer: "Jordan Lee" });
    expect(receipt.execution.providerResponse?.status).toBe("PENDING");
    expect(receipt.verification).toMatchObject({ status: "Verified", independentReadback: {
      id: refund.id, status: "COMPLETED", paymentId: terms.reference, amountCents: 5000, currency: "USD",
    } });
    expect(JSON.stringify(receipt)).not.toContain("idempotency");
    expect(JSON.stringify(receipt)).not.toContain("fixture-key");
    expect(await operator.send(execute)).toEqual(completed);
    expect(mock.posts).toHaveLength(2);
    expect(await operator.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ balanceCents: 7000, reservedCents: 0 });
  });

  it.each([
    { denyRefund: false, failMerchantRead: 3, posts: 0 },
    { denyRefund: true, failMerchantRead: 0, posts: 1 },
    ...["REFUND_AMOUNT_INVALID", "PAYMENT_NOT_REFUNDABLE", "PAYMENT_NOT_REFUNDABLE_DUE_TO_DISPUTE",
      "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION"].map(rejectionCode => ({ denyRefund: true, failMerchantRead: 0, posts: 1, rejectionCode })),
  ])(
    "stops a definite first Square failure and releases the reservation ($posts POSTs)", async (failure) => {
      const mock = provider();
      Object.assign(mock.settings, failure);
      const server = app(undefined, users, undefined, mock.square);
      const cashier = await signIn(server, "maya");
      const manager = await signIn(server, "jordan");
      const request = await cashier.send<RefundRequest>(submit());
      await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
      const execute = { action: "executeElectronicRefund", id: request.id };
      const stopped = await cashier.send<RefundRequest>(execute);
      expect(stopped.events.at(-1)).toMatchObject({ kind: "Execution stopped" });
      expect(requestReceipt(stopped).execution.status).toBe("Not submitted");
      expect(mock.posts).toHaveLength(failure.posts);
      expect(mock.ledger.size).toBe(0);
      expect(await cashier.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
        .toMatchObject({ balanceCents: 12000, reservedCents: 0 });
      expect(await cashier.send(execute)).toEqual(stopped);
      expect(mock.posts).toHaveLength(failure.posts);
    });

  it("keeps an earlier uncertain Square attempt held if a later retry is denied permission", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const execute = { action: "executeElectronicRefund", id: request.id };
    mock.settings.loseResponse = true;
    await cashier.send(execute);
    mock.settings.denyRefund = true;
    const stillHeld = await cashier.send<RefundRequest>(execute);
    expect(requestReceipt(stillHeld).execution.status).toBe("Outcome unconfirmed");
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[0]).toEqual(mock.posts[1]);
    expect(mock.ledger.size).toBe(1);
    expect(await cashier.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ reservedCents: 5000 });
  });

  it("subtracts external and locally recorded pending Square refunds exactly once", async () => {
    const mock = provider();
    mock.settings.refundIds = ["earlier-refund"];
    mock.settings.priorRefundStatus = "PENDING";
    mock.settings.readback = { ...refund, status: "PENDING" };
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const lookup = { action: "lookupOriginalSale", source: "square", reference: terms.reference };
    expect(await cashier.send(lookup)).toMatchObject({ balanceCents: 7000, reservedCents: 0 });
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const submitted = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    expect(requestReceipt(submitted).verification.status).toBe("Pending");
    expect(await cashier.send(lookup)).toMatchObject({ balanceCents: 2000, reservedCents: 0 });
    const above = await cashier.send<RefundRequest>(submit({ amount: "20.01" }));
    expect(requestStatus(above)).toBe("Blocked · Over refundable balance");
    expect((await cashier.request({ action: "executeElectronicRefund", id: above.id })).status).toBe(409);
    expect(mock.posts).toHaveLength(1);
  });

  it("holds a below-threshold Square refund and submits the exact approved amount despite a late external refund", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const requester = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const request = await requester.send<RefundRequest>(submit({ amount: "20.00" }));
    const execute = { action: "executeElectronicRefund", id: request.id };
    const approve = { action: "decideRefundRequest", id: request.id, decision: "Approved", password };
    const submitToSquare = mock.square.submit.bind(mock.square);
    const squareSubmit = vi.spyOn(mock.square, "submit").mockImplementationOnce((attempt, authorize) => {
      // An external $50 refund posts after the final provider lookup on the $120 sale.
      mock.settings.refundIds = ["earlier-refund"];
      mock.settings.priorRefundStatus = "PENDING";
      return submitToSquare(attempt, authorize);
    });

    expect(requestStatus(request)).toBe("Needs manager decision");
    expect(requestReceipt(request).checks).toMatchObject({ cumulativeCents: 2000, thresholdCents: 5000 });
    expect((await requester.request(approve)).status).toBe(403);
    expect((await requester.request(execute)).status).toBe(409);
    expect(squareSubmit).not.toHaveBeenCalled();
    expect(mock.posts).toHaveLength(0);

    const approved = await supervisor.send<RefundRequest>(approve);
    expect(requestReceipt(approved).decision.status).toBe("Approved");
    expect(requestReceipt(approved).execution.status).toBe("Not submitted");
    expect(mock.posts).toHaveLength(0);

    await requester.send(execute);
    expect(squareSubmit).toHaveBeenCalledTimes(1);
    expect(mock.posts).toEqual([expect.objectContaining({
      payment_id: terms.reference, amount_money: { amount: 2000, currency: "USD" },
    })]);
  });

  it("requires approval for a Square request saved with the old routine route", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const requester = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const request = await requester.send<RefundRequest>(submit({ amount: "20.00" }));
    const db = new DatabaseSync(server.path);
    try {
      db.prepare(`UPDATE team_refund_request_events
        SET payload=json_set(payload, '$.check.route', 'routine')
        WHERE merchant_id=? AND request_id=? AND json_extract(payload, '$.kind')='Checks recorded'`)
        .run("harbor", request.id);
    } finally {
      db.close();
    }

    const reopened = await requester.send<RefundRequest>({ action: "openRefundRequest", id: request.id });
    expect(requestStatus(reopened)).toBe("Needs manager decision");
    expect((await requester.request({ action: "executeElectronicRefund", id: request.id })).status).toBe(409);
    expect(mock.posts).toHaveLength(0);
    const approved = await supervisor.send<RefundRequest>({
      action: "decideRefundRequest", id: request.id, decision: "Approved", password,
    });
    expect(requestStatus(approved)).toBe("Ready for Square Sandbox refund");
  });

  it("shares the Square dispatch claim across two processes and recovers the same refund after sign-out and restart", async () => {
    const mock = provider();
    const path = processDatabase();
    const first = await appProcess(path, mock.transport);
    const second = await appProcess(path, mock.transport);
    expect(first.pid).not.toBe(second.pid);
    const cashier = await signIn(first, "maya");
    const supervisor = await signIn(second, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    const action = { action: "executeElectronicRefund", id: request.id };
    const lookup = { action: "lookupOriginalSale", source: "square", reference: terms.reference };
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });

    const resume = Promise.withResolvers<void>();
    mock.settings.afterPost = async count => { if (count === 1) await resume.promise; };
    mock.settings.loseResponse = true;
    const attempt = cashier.request(action);
    try {
      await vi.waitFor(() => expect(mock.ledger.size).toBe(1));
      const repeat = await supervisor.send<RefundRequest>(action);
      const reconcile = await supervisor.send<RefundRequest>({ ...action, action: "verifyElectronicRefund" });
      expect(requestReceipt(repeat).execution.status).toBe("Outcome unconfirmed");
      expect(requestReceipt(reconcile).execution.status).toBe("Outcome unconfirmed");
      expect(await supervisor.send(lookup)).toMatchObject({ reservedCents: 5000 });
      expect(mock.posts).toHaveLength(1);
      expect((await cashier.request({ action: "signOut" })).status).toBe(200);
    } finally {
      resume.resolve();
    }
    expect((await attempt).status).toBe(401);
    expect((await cashier.request(action)).status).toBe(401);
    await first.stop();
    await second.stop();

    mock.settings.loseResponse = false;
    const restarted = await appProcess(path, mock.transport);
    const operator = await signIn(restarted, "maya");
    expect(await operator.send(lookup)).toMatchObject({ reservedCents: 5000 });
    expect((await operator.send<RefundRequest>({ action: "openRefundRequest", id: request.id })).id).toBe(request.id);
    const receipt = requestReceipt(await operator.send<RefundRequest>(action));
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[1]).toEqual(mock.posts[0]);
    expect(mock.posts[0]).toMatchObject({ idempotency_key: expect.any(String), amount_money: { amount: 5000, currency: "USD" } });
    expect(mock.ledger.size).toBe(1);
    expect(receipt).toMatchObject({ transactionId: request.id, decision: { status: "Approved", reviewer: "Jordan Lee" },
      verification: { status: "Verified", independentReadback: { id: refund.id, paymentId: terms.reference, amountCents: 5000, currency: "USD" } } });
    expect(await operator.send(lookup)).toMatchObject({ balanceCents: 7000, reservedCents: 0 });
  }, 20_000);

  it("cannot release a Square reservation after another process takes over an expired claim", async () => {
    const mock = provider();
    const path = processDatabase();
    const first = await appProcess(path, mock.transport);
    const second = await appProcess(path, mock.transport);
    const cashier = await signIn(first, "maya");
    const supervisor = await signIn(second, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    const action = { action: "executeElectronicRefund", id: request.id };
    const lookup = { action: "lookupOriginalSale", source: "square", reference: terms.reference };
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });

    const entered = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>(), finishSecond = Promise.withResolvers<void>();
    mock.settings.failMerchantRead = 3;
    mock.settings.beforeMerchantRead = async read => {
      if (read !== 3) return;
      entered.resolve();
      await finishFirst.promise;
    };
    mock.settings.afterPost = () => finishSecond.promise;
    const attempt = cashier.send<RefundRequest>(action);
    try {
      await entered.promise;
      const db = new DatabaseSync(path);
      try {
        expect(db.prepare("UPDATE team_square_dispatches SET expires_at=0 WHERE request_id=?").run(request.id).changes).toBe(1);
      } finally {
        db.close();
      }
      const replacement = supervisor.send<RefundRequest>(action);
      await vi.waitFor(() => expect(mock.ledger.size).toBe(1));
      finishFirst.resolve();
      expect(requestReceipt(await attempt).execution.status).toBe("Outcome unconfirmed");
      expect(await supervisor.send(lookup)).toMatchObject({ reservedCents: 5000 });
      expect(mock.posts).toHaveLength(1);
      finishSecond.resolve();
      expect(requestReceipt(await replacement).verification.status).toBe("Verified");
      expect(await supervisor.send(lookup)).toMatchObject({ balanceCents: 7000, reservedCents: 0 });
    } finally {
      finishFirst.resolve();
      finishSecond.resolve();
    }
  }, 20_000);

  it("blocks Square submission if the operator signs out during the last merchant check", async () => {
    const mock = provider();
    const path = processDatabase();
    const first = await appProcess(path, mock.transport);
    const second = await appProcess(path, mock.transport);
    const cashier = await signIn(first, "maya");
    const supervisor = await signIn(second, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    const action = { action: "executeElectronicRefund", id: request.id };
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });

    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    mock.settings.beforeMerchantRead = async read => {
      if (read !== 3) return;
      entered.resolve();
      await resume.promise;
    };
    const pending = cashier.request(action);
    try {
      await entered.promise;
      expect((await cashier.request({ action: "signOut" })).status).toBe(200);
      expect((await cashier.request(action)).status).toBe(401);
      expect(mock.posts).toHaveLength(0);
    } finally {
      resume.resolve();
    }
    expect((await pending).status).toBe(401);
    expect(mock.posts).toHaveLength(0);
    expect(mock.ledger.size).toBe(0);
    expect(await supervisor.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ balanceCents: 7000, reservedCents: 5000 });
  }, 20_000);

  it("coalesces concurrent Square submissions while the first call is in flight", async () => {
    const mock = provider();
    let release!: () => void;
    mock.settings.waitForPost = new Promise<void>(resolve => { release = resolve; });
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const execute = { action: "executeElectronicRefund", id: request.id };
    const first = cashier.send<RefundRequest>(execute);
    try {
      await vi.waitFor(() => expect(mock.posts).toHaveLength(1));
      const repeated = await cashier.send<RefundRequest>(execute);
      expect(requestReceipt(repeated).execution.status).toBe("Outcome unconfirmed");
      expect(mock.posts).toHaveLength(1);
    } finally {
      release();
      await first;
    }
  });

  it("blocks rejected refunds and refunds that exceed a fresh provider balance", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const rejected = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: rejected.id, decision: "Rejected", password });
    expect((await cashier.request({ action: "executeElectronicRefund", id: rejected.id })).status).toBe(409);
    const approved = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: approved.id, decision: "Approved", password });
    mock.settings.total = 4900;
    const result = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: approved.id });
    expect(requestStatus(result)).toBe("Blocked · No refund submitted");
    expect(requestReceipt(result).execution.status).toBe("Not submitted");
    expect(await cashier.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ balanceCents: 4900, reservedCents: 0 });
    expect(mock.posts).toEqual([]);
  });

  it("rejects expired Square payments and payments that reached the refund limit", async () => {
    const mock = provider();
    const cashier = await signIn(app(undefined, users, undefined, mock.square), "maya");
    mock.settings.createdAt = "2020-01-01T00:00:00Z";
    expect(await (await cashier.request(submit())).json()).toEqual({ error: "SQUARE_SALE_INELIGIBLE" });
    mock.settings.createdAt = new Date().toISOString();
    mock.settings.refundIds = Array.from({ length: 20 }, (_, index) => "refund-" + index);
    expect(await (await cashier.request(submit())).json()).toEqual({ error: "SQUARE_SALE_INELIGIBLE" });
    expect(mock.posts).toHaveLength(0);
  });

  it("blocks the first Square submission when a prior failed refund appears after approval", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    mock.settings.refundIds = ["earlier-refund"];
    const stopped = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    expect(mock.posts).toHaveLength(0);
    expect(requestReceipt(stopped).execution.status).toBe("Not submitted");
    expect(stopped.events.at(-1)).toMatchObject({ kind: "Execution stopped", reason: expect.stringContaining("earlier refund failed") });
    expect(await (await cashier.request(submit())).json()).toEqual({ error: "SQUARE_PRIOR_REFUND_FAILED" });
    mock.settings.priorRefundStatus = "REJECTED";
    expect(await cashier.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ balanceCents: 12000, reservedCents: 0 });
  });

  it("reuses one uncertain Square attempt through exactly 15 minutes and preserves its hold after the cutoff", async () => {
    const mock = provider();
    mock.settings.loseResponse = true;
    const started = Date.parse("2026-11-22T12:00:00Z");
    const cutoff = 15 * 60_000;
    let clock = started;
    const server = app(undefined, users, () => new Date(clock).toISOString(), mock.square);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const execute = { action: "executeElectronicRefund", id: request.id };
    const original = await cashier.send<RefundRequest>(execute);
    expect(mock.posts).toHaveLength(1);
    const originalPost = mock.posts[0];
    expect(originalPost).toMatchObject({ idempotency_key: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    clock = started + cutoff - 1;
    await cashier.send(execute);
    expect(mock.posts).toHaveLength(2);
    clock = started + cutoff;
    const atCutoff = await cashier.send<RefundRequest>(execute);
    expect(mock.posts).toEqual([originalPost, originalPost, originalPost]);
    // Begin another retry just before the cutoff, then run the final authorization after it.
    clock = started + cutoff - 1;
    mock.settings.beforeMerchantRead = async () => { clock = started + cutoff + 1; };
    const crossedCutoff = await cashier.request(execute);
    expect(crossedCutoff.status).toBe(409);
    expect(await crossedCutoff.json()).toEqual({ error: "SQUARE_RECONCILIATION_REQUIRED" });
    expect(mock.posts).toHaveLength(3);

    const denied = await cashier.request(execute);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "SQUARE_RECONCILIATION_REQUIRED" });
    expect(mock.posts).toHaveLength(3);
    expect(mock.ledger.size).toBe(1);
    expect(await cashier.send({ action: "openRefundRequest", id: request.id })).toEqual(atCutoff);
    expect(atCutoff.events.filter(event => event.kind === "Square attempt recorded"))
      .toEqual(original.events.filter(event => event.kind === "Square attempt recorded"));
    expect(await cashier.send({ action: "lookupOriginalSale", source: "square", reference: terms.reference }))
      .toMatchObject({ reservedCents: 5000 });
  });

  it("denies Square balance lookup after the cashier signs out during the provider read", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    mock.settings.beforePaymentRead = async () => { entered.resolve(); await resume.promise; };
    const lookup = cashier.request({ action: "lookupOriginalSale", source: "square", reference: terms.reference });
    await entered.promise;
    try {
      expect((await cashier.request({ action: "signOut" })).ok).toBe(true);
    } finally {
      resume.resolve();
    }
    expect((await lookup).status).toBe(401);
    expect(mock.posts).toHaveLength(0);
  });

  it("requires the configured seller, location, completed status and USD", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    mock.settings.merchant = "other-merchant";
    expect((await cashier.request(submit())).status).toBe(503);
    mock.settings.merchant = config.merchantId;
    for (const change of [{ location: "other-location" }, { status: "APPROVED" }, { currency: "CAD" }]) {
      Object.assign(mock.settings, { location: config.locationId, status: "COMPLETED", currency: "USD" }, change);
      expect((await cashier.request(submit())).status).toBe(422);
    }
    expect(await cashier.send({ action: "listRefundRequests" })).toEqual([]);
    expect(mock.posts).toEqual([]);
  });

  it("keeps confirmation pending on unavailable, pending or mismatched readback without resubmitting", async () => {
    const mock = provider();
    const server = app(undefined, users, undefined, mock.square);
    const cashier = await signIn(server, "maya");
    const request = await cashier.send<RefundRequest>(submit({ amount: "12.34" }));
    const supervisor = await signIn(server, "jordan");
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    mock.settings.visible = false;
    const result = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    expect(requestReceipt(result).verification.status).toBe("Unconfirmed");
    mock.settings.visible = true;
    const verify = { action: "verifyElectronicRefund", id: request.id };
    mock.settings.readback = { ...refund, status: "PENDING", amount_money: { amount: 1234, currency: "USD" } };
    expect(requestReceipt(await cashier.send<RefundRequest>(verify)).verification.status).toBe("Pending");
    mock.settings.readback = { ...refund, payment_id: "unrelated-payment" };
    expect(requestReceipt(await cashier.send<RefundRequest>(verify)).verification.status).toBe("Mismatch");
    mock.settings.readback = { ...refund, status: "FAILED", amount_money: { amount: 1234, currency: "USD" } };
    expect(requestReceipt(await cashier.send<RefundRequest>(verify)).verification.status).toBe("Failed");
    expect(mock.posts).toHaveLength(1);
  });
});

describe("PayPal Sandbox refunds with simulated transport", () => {
  const users: Employee[] = roster.map(employee => ({ ...employee, role: "manager" }));
  const capture = "MOCKCAPTURE123";
  const order = "MOCKORDER123";
  const refund = "MOCKREFUND123";
  const merchantId = "MOCKMERCHANT123";
  const terms = { source: "paypal", reference: capture, amount: "50.00", currency: "USD", reason: "Simulated PayPal" };
  const source = { action: "lookupOriginalSale", source: "paypal", reference: capture };
  const submit = (amount = terms.amount) => ({ action: "createRefundRequest", submissionId: randomUUID(), terms: { ...terms, amount } });
  const completedPrior = { id: "MOCKPRIORCOMPLETE", status: "COMPLETED", amount: "17.23" };
  const pendingPrior = { id: "MOCKPRIORPENDING", status: "PENDING", amount: "8.64" };

  function simulator(allowRefunds = true) {
    const posts: { key: string; invoice: string }[] = [];
    const priorRefunds: { id: string; status: string; amount: string }[] = [];
    const settings = { payee: merchantId, lost: true, visible: true, denied: false, amount: "50.00", invoice: "",
      expectedAmount: "50.00", captureAmount: "120.00", providerStatus: "COMPLETED", beforeRead: async () => {},
      beforeSubmit: async () => {}, beforeCaptureRead: async () => {}, beforeOAuth: async () => {}, tokenLifetime: 120, unreadableRefund: "" };
    const transport = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://api-m.sandbox.paypal.com");
      const money = (value: string) => ({ value, currency_code: "USD" });
      if (url.pathname === "/v1/oauth2/token") {
        await settings.beforeOAuth();
        return Response.json({ access_token: "fixture-bearer", token_type: "Bearer", expires_in: settings.tokenLifetime });
      }
      if (url.pathname === "/v2/payments/captures/" + capture) {
        await settings.beforeCaptureRead();
        const totalRefunded = priorRefunds.filter(row => row.status === "COMPLETED")
          .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100),
            posts.length && settings.providerStatus === "COMPLETED" ? Math.round(Number(settings.amount) * 100) : 0);
        return Response.json({ id: capture, amount: money(settings.captureAmount),
          status: totalRefunded === Math.round(Number(settings.captureAmount) * 100) ? "REFUNDED" : totalRefunded ? "PARTIALLY_REFUNDED" : "COMPLETED",
          supplementary_data: { related_ids: { order_id: order } } });
      }
      if (url.pathname === "/v2/checkout/orders/" + order) return Response.json({ id: order, purchase_units: [
        { payee: { merchant_id: settings.payee }, payments: { captures: [{ id: capture }],
          refunds: [...priorRefunds.map(({ id }) => ({ id })), ...(posts.length && settings.visible ? [{ id: refund }] : [])] } },
      ] });
      if (url.pathname === "/v2/payments/captures/" + capture + "/refund" && init.method === "POST") {
        await settings.beforeSubmit();
        if (settings.denied) return Response.json({ name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, { status: 422 });
        const key = new Headers(init.headers).get("PayPal-Request-Id") ?? "";
        const body = JSON.parse(String(init.body)) as { amount: unknown; invoice_id: string };
        expect(key).toMatch(/^[a-f0-9-]{36}$/);
        expect(body.amount).toEqual(money(settings.expectedAmount));
        expect(body.invoice_id).toBe("changegate-" + key);
        posts.push({ key, invoice: body.invoice_id });
        if (settings.lost) throw new Error("simulated lost reply");
        return Response.json({ id: refund });
      }
      if (url.pathname === "/v2/payments/refunds/" + refund && settings.visible) {
        await settings.beforeRead();
        return Response.json({ id: refund, amount: money(settings.amount), status: settings.providerStatus,
          invoice_id: settings.invoice || posts[0]?.invoice, links: [
            { rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/" + capture, method: "GET" },
          ] });
      }
      const prior = priorRefunds.find(row => url.pathname === "/v2/payments/refunds/" + row.id);
      if (prior) {
        if (settings.unreadableRefund === prior.id) return new Response(null, { status: 503 });
        return Response.json({ id: prior.id, amount: money(prior.amount), status: prior.status, links: [
          { rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/" + capture, method: "GET" },
        ] });
      }
      return new Response(null, { status: 404 });
    });
    const connect = () => new PayPalProvider({ teamMerchantId: "harbor", merchantId, clientId: "mock-client",
      clientSecret: "mock-secret", allowRefunds }, transport);
    const refundSubmissions = () => transport.mock.calls.filter(([url, init]) =>
      init.method === "POST" && new URL(url).pathname === "/v2/payments/captures/" + capture + "/refund");
    return { settings, transport, connect, provider: connect(), posts, priorRefunds, refundSubmissions };
  }

  it("routes an unlocated PayPal hold to the merchant's enrolled primary and backup supervisors", async () => {
    const mock = simulator();
    const backup = { ...users[1]!, username: "pay-backup" };
    const server = app(undefined, [...users, backup], undefined, undefined, mock.provider);
    function enroll(member: Employee, duty: "primary" | "backup", location: string) {
      server.store.alerts.enroll(member, { duty, location,
        endpoint: "https://fcm.googleapis.com/" + member.username,
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } });
    }
    enroll(users[0]!, "primary", "Harbor Fuel");
    enroll(users[1]!, "primary", "Harbor Fuel");
    enroll(backup, "backup", "Harbor Bar");
    enroll(users[2]!, "primary", "Harbor Fuel");

    const cashier = await signIn(server, "maya");
    const request = await cashier.send<RefundRequest>(submit());
    expect(request.sale?.location).toBe("Unavailable");
    expect(requestStatus(request)).toBe("Needs manager decision");

    const primary = server.store.alerts.claim(Date.now())!;
    expect(primary).toMatchObject({ requestId: request.id, phase: 0 });
    expect(server.store.alerts.recipients(primary).map(row => row.username)).toEqual(["jordan"]);
    expect(server.store.alerts.recipients({ ...primary, location: "Harbor Bar" })).toEqual([]);
    server.store.alerts.finish(primary, "push accepted");

    const escalation = server.store.alerts.claim(Date.now() + 30 * 60_000)!;
    expect(escalation).toMatchObject({ requestId: request.id, phase: 1 });
    expect(server.store.alerts.recipients(escalation).map(row => row.username)).toEqual(["pay-backup"]);
    const blocked = await cashier.request({ action: "executeElectronicRefund", id: request.id });
    expect(blocked.status).toBe(409);
    expect(mock.refundSubmissions()).toHaveLength(0);
  });

  it("excludes PayPal's unavailable register but retains the cashier monitoring threshold", async () => {
    const mock = simulator();
    mock.settings.captureAmount = "300.00";
    const roles: Employee[] = [...users, { ...users[0]!, username: "pay-operator", role: "cashier" },
      { ...users[0]!, username: "pay-owner", role: "owner" }];
    const server = app(undefined, roles, undefined, undefined, mock.provider);
    const owner = await signIn(server, "pay-owner");
    await owner.send({ action: "setRefundPolicy", thresholdCents: 25000 });
    const first = await signIn(server, "maya");
    const second = await signIn(server, "jordan");
    const third = await signIn(server, "pay-operator");
    for (const operator of [first, second, third]) {
      const request = await operator.send<RefundRequest>(submit("34.00"));
      expect(request.events.find(event => event.kind === "Checks recorded")).toMatchObject({ check: {
        route: "routine", monitoring: { watch: true, cashierWatchCount: 1, registerWatchCount: 0 },
      } });
    }
    const secondForCashier = await first.send<RefundRequest>(submit("34.00"));
    expect(secondForCashier.events.find(event => event.kind === "Checks recorded")).toMatchObject({ check: {
      route: "routine", monitoring: { cashierWatchCount: 2, registerWatchCount: 0 },
    } });
    const thirdForCashier = await first.send<RefundRequest>(submit("34.00"));
    expect(thirdForCashier.events.find(event => event.kind === "Checks recorded")).toMatchObject({ check: {
      route: "manager", monitoring: { cashierWatchCount: 3, registerWatchCount: 0 },
    } });
    expect(mock.refundSubmissions()).toHaveLength(0);
  });

  it.each([
    { label: "completed", history: [completedPrior], cents: 10277, amount: "102.77" },
    { label: "pending", history: [pendingPrior], cents: 11136, amount: "111.36" },
    { label: "completed and pending", history: [completedPrior, pendingPrior], cents: 9413, amount: "94.13" },
  ])("allows exactly the available PayPal balance with earlier $label refunds", async ({ history, cents, amount }) => {
    const mock = simulator();
    mock.priorRefunds.push(...history);
    Object.assign(mock.settings, { lost: false, expectedAmount: amount, amount });
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    expect(await cashier.send(source)).toMatchObject({ balanceCents: cents, reservedCents: 0 });
    const request = await cashier.send<RefundRequest>(submit(amount));
    const execute = { action: "executeElectronicRefund", id: request.id };
    expect((await cashier.request(execute)).status).toBe(409);
    expect(mock.refundSubmissions()).toHaveLength(0);
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const receipt = requestReceipt(await cashier.send<RefundRequest>(execute));
    expect(mock.refundSubmissions()).toHaveLength(1);
    expect(receipt.verification).toMatchObject({ status: "Verified", independentReadback: { amountCents: cents, currency: "USD" } });
  });

  it("does not submit an approved PayPal request one cent above the fresh available balance", async () => {
    const mock = simulator();
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit("94.14"));
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    mock.priorRefunds.push(completedPrior, pendingPrior);
    const attempt = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    expect(requestReceipt(attempt).execution.status).toBe("Not submitted");
    expect(attempt.events.at(-1)).toMatchObject({ kind: "Execution stopped" });
    expect(await cashier.send(source)).toMatchObject({ balanceCents: 9413, reservedCents: 0 });
    expect(mock.refundSubmissions()).toHaveLength(0);
  });

  it("does not submit when approved PayPal refund history becomes unreadable", async () => {
    const mock = simulator();
    mock.priorRefunds.push(completedPrior);
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    mock.settings.unreadableRefund = completedPrior.id;
    const denied = await cashier.request({ action: "executeElectronicRefund", id: request.id });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "PAYPAL_HISTORY_UNAVAILABLE" });
    const stored = await cashier.send<RefundRequest>({ action: "openRefundRequest", id: request.id });
    expect(requestReceipt(stored).execution.attempt).toBeNull();
    expect(mock.refundSubmissions()).toHaveLength(0);
  });

  it("makes no provider calls when settings are missing or PayPal is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const paypal of [configuredPayPalSandbox({}), configuredPayPalSandbox({ CHANGEGATE_PAYPAL_MODE: "sandbox" }),
        configuredPayPalSandbox({ CHANGEGATE_PAYPAL_MODE: "production" })]) {
        expect(paypal).toBeUndefined();
        const cashier = await signIn(app(undefined, users, undefined, undefined, paypal), "maya");
        expect(cashier.user.paypalConnected).toBe(false);
        expect(await (await cashier.request(source)).json()).toEqual({ error: "PAYPAL_NOT_CONNECTED" });
        expect(await (await cashier.request(submit())).json()).toEqual({ error: "PAYPAL_NOT_CONNECTED" });
        expect(await (await cashier.request({ ...source, source: "square" })).json())
          .toEqual({ error: "SQUARE_NOT_CONNECTED" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("holds for a separate supervisor and reconciles the original request after a lost reply and restart", async () => {
    const mock = simulator();
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const otherMerchant = await signIn(server, "alex");
    expect(await cashier.send(source)).toMatchObject({ balanceCents: 12000, sale: { paypal: { orderId: order } } });
    expect((await otherMerchant.request(source)).status).toBe(503);
    const request = await cashier.send<RefundRequest>(submit());
    const execute = { action: "executeElectronicRefund", id: request.id };
    const approval = { action: "decideRefundRequest", id: request.id, decision: "Approved", password };
    expect((await cashier.request(execute)).status).toBe(409);
    expect((await cashier.request(approval)).status).toBe(403);
    expect((await otherMerchant.request(execute)).status).toBe(404);
    expect(mock.posts).toHaveLength(0);
    await manager.send(approval);
    const lost = await cashier.send<RefundRequest>(execute);
    expect(requestReceipt(lost).execution.status).toBe("Outcome unconfirmed");
    expect(mock.posts).toHaveLength(1);
    server.stop();
    const disconnected = app(server.path, users);
    const disconnectedUser = await signIn(disconnected, "maya");
    const callsBefore = mock.transport.mock.calls.length;
    expect(await (await disconnectedUser.request(execute)).json()).toEqual({ error: "PAYPAL_NOT_CONNECTED" });
    expect(mock.transport.mock.calls).toHaveLength(callsBefore);
    disconnected.stop();
    const restarted = app(server.path, users, undefined, undefined, mock.connect());
    const operator = await signIn(restarted, "maya");
    const retry = { action: "verifyElectronicRefund", id: request.id };
    mock.settings.visible = false;
    expect(requestReceipt(await operator.send<RefundRequest>(retry)).verification.status).toBe("Unconfirmed");
    mock.settings.visible = true;
    mock.settings.invoice = "wrong-invoice";
    expect(requestReceipt(await operator.send<RefundRequest>(retry)).verification.status).toBe("Unconfirmed");
    mock.settings.invoice = "";
    const receipt = requestReceipt(await operator.send<RefundRequest>(retry));
    expect(receipt.decision).toMatchObject({ status: "Approved", reviewer: "Jordan Lee" });
    expect(receipt.execution.status).toBe("Provider reference recorded");
    expect(receipt.verification).toMatchObject({ status: "Verified", independentReadback: {
      id: refund, paymentId: capture, amountCents: 5000, currency: "USD", status: "COMPLETED",
    } });
    expect(JSON.stringify(receipt)).not.toContain(mock.posts[0]?.key);
    expect(JSON.stringify(receipt)).not.toContain("fixture-bearer");
    await operator.send(execute);
    expect(mock.posts).toHaveLength(1);
    expect(await operator.send(source)).toMatchObject({ balanceCents: 7000, reservedCents: 0 });
  });

  it("blocks unowned capture lookup and allows read-only lookup without starting a refund attempt", async () => {
    const mock = simulator(false);
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    mock.settings.payee = "OTHERPAYEE";
    expect((await cashier.request(source)).status).toBe(422);
    mock.settings.payee = merchantId;
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    expect(await (await cashier.request({ action: "executeElectronicRefund", id: request.id })).json())
      .toEqual({ error: "PAYPAL_REFUNDS_DISABLED" });
    expect(mock.posts).toHaveLength(0);
  });

  it("submits once on double click and distinguishes pending, failed and mismatched provider results", async () => {
    const mock = simulator();
    mock.settings.lost = false;
    mock.settings.providerStatus = "PENDING";
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const execute = { action: "executeElectronicRefund", id: request.id };
    await Promise.all([cashier.send(execute), cashier.send(execute)]);
    expect(mock.posts).toHaveLength(1);
    const read = { action: "verifyElectronicRefund", id: request.id };
    expect(requestReceipt(await cashier.send<RefundRequest>(read)).verification.status).toBe("Pending");
    mock.settings.providerStatus = "COMPLETED";
    mock.settings.amount = "49.00";
    expect(requestReceipt(await cashier.send<RefundRequest>(read)).verification.status).toBe("Mismatch");
    mock.settings.providerStatus = "FAILED";
    mock.settings.amount = "50.00";
    expect(requestReceipt(await cashier.send<RefundRequest>(read)).verification.status).toBe("Failed");
    expect(mock.posts).toHaveLength(1);
  });

  it("releases the reservation after a definite PayPal rejection", async () => {
    const mock = simulator();
    mock.settings.denied = true;
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const execute = { action: "executeElectronicRefund", id: request.id };
    const result = await cashier.send<RefundRequest>(execute);
    expect(requestReceipt(result).execution.status).toBe("Not submitted");
    expect(result.events.at(-1)).toMatchObject({ kind: "Execution stopped" });
    expect(await cashier.send(source)).toMatchObject({ balanceCents: 12000, reservedCents: 0 });
    expect(await cashier.send(execute)).toEqual(result);
    expect(mock.posts).toHaveLength(0);
  });

  it("counts a known PayPal refund once after readback recovers and retains the hold if the amount disagrees", async () => {
    const mock = simulator();
    mock.settings.lost = false;
    mock.settings.visible = false;
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const attempted = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    expect(requestReceipt(attempted).verification.status).toBe("Unconfirmed");
    mock.settings.visible = true;
    mock.settings.amount = "49.99";
    expect(await cashier.send(source)).toMatchObject({ balanceCents: 2001, reservedCents: 5000 });
    mock.settings.amount = "50.00";
    expect(await cashier.send(source)).toMatchObject({ balanceCents: 7000, reservedCents: 0 });
    expect(mock.refundSubmissions()).toHaveLength(1);
  });

  it.each(["lowered threshold", "new external refund"])("holds routine PayPal execution after a %s", async change => {
    const mock = simulator();
    Object.assign(mock.settings, { lost: false, amount: "20.00", expectedAmount: "20.00" });
    const roles: Employee[] = [...users, { ...users[0]!, username: "pay-owner", role: "owner" }];
    const server = app(undefined, roles, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit("20.00"));
    expect(requestStatus(request)).toBe("Ready for PayPal Sandbox refund");

    if (change === "lowered threshold") {
      const owner = await signIn(server, "pay-owner");
      await owner.send({ action: "setRefundPolicy", thresholdCents: 2000 });
    } else {
      mock.priorRefunds.push({ ...pendingPrior, amount: "30.00" });
    }

    const execute = { action: "executeElectronicRefund", id: request.id };
    const held = await supervisor.send<RefundRequest>(execute);
    expect(requestStatus(held)).toBe("Needs manager decision");
    expect(requestReceipt(held).execution.attempt).toBeNull();
    expect(server.store.alerts.claim(Date.now())).toMatchObject({ requestId: request.id, requester: "maya", route: "manager" });
    expect((await cashier.request(execute)).status).toBe(409);
    expect(mock.refundSubmissions()).toHaveLength(0);
    const approve = { action: "decideRefundRequest", id: request.id, decision: "Approved", password };
    expect((await cashier.request(approve)).status).toBe(403);
    await supervisor.send(approve);
    expect(requestReceipt(await cashier.send<RefundRequest>(execute)).verification.status).toBe("Verified");
    expect(mock.refundSubmissions()).toHaveLength(1);
  });

  it.each([true, false])("keeps the PayPal outcome but denies a signed-out caller (definite rejection: %s)", async denied => {
    const mock = simulator();
    mock.settings.denied = denied;
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    mock.settings.beforeSubmit = async () => { entered.resolve(); await resume.promise; };
    const execute = { action: "executeElectronicRefund", id: request.id };
    const submitting = cashier.request(execute);
    await entered.promise;
    try {
      expect((await cashier.request({ action: "signOut" })).ok).toBe(true);
    } finally {
      resume.resolve();
    }

    expect((await submitting).status).toBe(401);
    const saved = await supervisor.send<RefundRequest>({ action: "openRefundRequest", id: request.id });
    expect(requestReceipt(saved).execution.status).toBe(denied ? "Not submitted" : "Outcome unconfirmed");
    expect(await supervisor.send(source)).toMatchObject({ reservedCents: denied ? 0 : 5000 });
    if (!denied) {
      expect(requestReceipt(await supervisor.send<RefundRequest>(execute)).verification.status).toBe("Verified");
    }
    expect(mock.refundSubmissions()).toHaveLength(1);
  });

  it("stops PayPal execution when the operator signs out during submission OAuth refresh", async () => {
    const mock = simulator();
    mock.settings.tokenLifetime = 1;
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const supervisor = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await supervisor.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });

    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const submitToPayPal = mock.provider.submit.bind(mock.provider);
    vi.spyOn(mock.provider, "submit").mockImplementationOnce((attempt, authorize) => {
      mock.settings.beforeOAuth = async () => { entered.resolve(); await resume.promise; };
      return submitToPayPal(attempt, authorize);
    });
    const execute = { action: "executeElectronicRefund", id: request.id };
    const submitting = cashier.request(execute);
    try {
      await entered.promise;
      expect((await cashier.request({ action: "signOut" })).ok).toBe(true);
    } finally {
      resume.resolve();
    }
    expect((await submitting).status).toBe(401);
    expect(mock.refundSubmissions()).toHaveLength(0);
    const saved = await supervisor.send<RefundRequest>({ action: "openRefundRequest", id: request.id });
    expect(requestReceipt(saved).execution.status).toBe("Not submitted");
    expect(await supervisor.send(source)).toMatchObject({ balanceCents: 12000, reservedCents: 0 });
  });

  it("denies PayPal balance lookup after the cashier signs out during the provider read", async () => {
    const mock = simulator();
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    mock.settings.beforeCaptureRead = async () => { entered.resolve(); await resume.promise; };
    const lookup = cashier.request(source);
    await entered.promise;
    try {
      expect((await cashier.request({ action: "signOut" })).ok).toBe(true);
    } finally {
      resume.resolve();
    }
    expect((await lookup).status).toBe(401);
    expect(mock.refundSubmissions()).toHaveLength(0);
  });

  it("prevents a revoked session from committing a PayPal readback", async () => {
    const mock = simulator();
    const server = app(undefined, users, undefined, undefined, mock.provider);
    const cashier = await signIn(server, "maya");
    const manager = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>(submit());
    await manager.send({ action: "decideRefundRequest", id: request.id, decision: "Approved", password });
    const attempt = await cashier.send<RefundRequest>({ action: "executeElectronicRefund", id: request.id });
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    mock.settings.beforeRead = async () => { entered.resolve(); await resume.promise; };
    const read = cashier.request({ action: "verifyElectronicRefund", id: request.id });
    await entered.promise;
    try {
      expect((await cashier.request({ action: "signOut" })).status).toBe(200);
    } finally {
      resume.resolve();
    }
    expect((await read).ok).toBe(false);
    expect(await manager.send({ action: "openRefundRequest", id: request.id })).toEqual(attempt);
    expect(mock.posts).toHaveLength(1);
  });
});

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

    // Use one stable rate-limit window even when CI starts just before a five-minute rollover.
    const fixedClock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 22, 13, 31));
    try {
      const throttled = { "X-Real-IP": "192.0.2.6" };
      for (let i = 0; i < 30; i++) {
        expect((await request({ ...signIn, password: "incorrect" }, throttled)).status).toBe(401);
      }
      expect((await request(signIn, throttled)).status).toBe(429);
    } finally {
      fixedClock.mockRestore();
    }
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

  it("previews the submission check and preserves a later refund recheck", async () => {
    const users: Employee[] = roster.map(employee => ({
      ...employee, role: employee.username === "jordan" ? "owner" : "cashier",
    }));
    const server = app(undefined, users, () => "2026-11-25T14:00:00.000Z");
    const cashier = await signIn(server, "maya");
    const owner = await signIn(server, "jordan");
    const request = await cashier.send<RefundRequest>({
      action: "createRefundRequest", submissionId: randomUUID(),
      terms: { reference: "TEST-SALE-PARTIAL", amount: "21.00", currency: "USD", reason: "Synthetic preview replay" },
    });
    const original = request.events.find(event => event.kind === "Checks recorded")!;
    expect(request.sale?.tender).toBe("Cash");
    expect(original.check).toMatchObject({
      cumulativeCents: 5000, balanceCents: 6100, thresholdCents: 5000, route: "manager",
      monitoring: { watch: false, cashierWatchCount: 0, registerWatchCount: 0, reasons: [original.check.explanation] },
    });
    expect(original.check.explanation).toContain("$50.00 store threshold");

    // Append a later check as saved history without executing a refund.
    const explanation = "Cumulative refunds would reach $50.01, meeting or exceeding the $50.00 store threshold.";
    const later = {
      ...original, occurredAt: "2026-11-25T14:05:00.000Z",
      check: {
        ...original.check, cumulativeCents: 5001, balanceCents: 6099, explanation,
        monitoring: { ...original.check.monitoring!, reasons: [explanation] },
      },
    };
    const db = new DatabaseSync(server.path);
    try {
      db.prepare(`INSERT INTO team_refund_request_events (merchant_id, request_id, username, payload)
        VALUES (?, ?, ?, ?)`).run("harbor", request.id, "jordan", JSON.stringify(later));
    } finally {
      db.close();
    }

    const open = { action: "openRefundRequest", id: request.id };
    const before = await owner.send<RefundRequest>(open);
    expect(before.events.filter(event => event.kind === "Checks recorded")).toEqual([original, later]);
    const preview = await owner.send({
      action: "previewRefundThreshold", location: "Harbor Bar", shift: "Evening", thresholdCents: 5001,
    });
    expect(preview).toMatchObject({
      currentCents: 5000, proposedCents: 5001, added: 0, removed: 1, insufficient: 0,
      rows: [{ id: request.id, current: "Supervisor review", proposed: "Routine" }],
    });
    expect(await owner.send(open)).toEqual(before);
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
    const preview = (thresholdCents: number, location = "Harbor Bar", shift = "Evening") =>
      ({ action: "previewRefundThreshold", location, shift, thresholdCents });
    const isolated = await cashier.send<RefundRequest>(command("TEST-SALE-PARTIAL", "21.00"));
    expect(checks(isolated)).toMatchObject({ route: "manager", monitoring: { reasons: [expect.stringContaining("$50.00 store threshold")] } });
    expect(await owner.send(preview(5001))).toMatchObject({ currentCents: 5000, proposedCents: 5001, added: 0, removed: 1,
      rows: [{ id: isolated.id, current: "Supervisor review", proposed: "Routine" }] });
    expect(await owner.send(preview(5000))).toMatchObject({ removed: 0, rows: [{ proposed: "Supervisor review" }] });
    expect(await owner.send({ action: "refundPolicy" })).toEqual({ thresholdCents: 5000 });
    expect(await cashier.send({ action: "openRefundRequest", id: isolated.id })).toEqual(isolated);
    await manager.send({ action: "decideRefundRequest", id: isolated.id, decision: "Rejected", password });
    const missing = await cashier.send<RefundRequest>(command("TEST-SALE-UNKNOWN", "1.00"));
    expect(await owner.send(preview(5001, "Unavailable", "Unavailable"))).toMatchObject({ added: 0, removed: 0, insufficient: 1,
      rows: [{ id: missing.id, proposed: "Insufficient evidence" }] });
    expect(await owner.send(preview(5001, "Harbor Fuel", "Morning"))).toMatchObject({ rows: [] });
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
    expect(JSON.stringify(second)).toContain("Cumulative refunds would reach $55.00");
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
    expect(requestStatus(fourth)).toBe("Ready for cash payout");
    server.stop();
    const restored = app(server.path, roles);
    expect(await (await signIn(restored, "maya")).send({ action: "openRefundRequest", id: second.id })).toEqual(approved);
  });

  it("holds at the exact cumulative threshold and queues a backup without releasing the hold", async () => {
    const server=app();
    const cashier=await signIn(server,"maya");
    const request=(reference:string, amount:string)=>cashier.send<RefundRequest>({action:"createRefundRequest",
      submissionId:randomUUID(),terms:{reference,amount,currency:"USD",reason:"Synthetic boundary test"}});
    for(const [reference,amount,present] of [["TEST-MONITOR-1","49.99",false],["TEST-MONITOR-2","50.00",true],
      ["TEST-MONITOR-3","50.01",true]] as const) {
      const record=await request(reference,amount);
      const validation=record.events.find(event=>event.kind==="Checks recorded");
      expect(validation?.check.monitoring?.reasons.some(reason=>reason.includes("store threshold"))).toBe(present);
      if(!present)continue;
      expect(requestStatus(record)).toBe("Needs manager decision");
      expect((await cashier.request({action:"reportCashPayout",id:record.id})).status).toBe(409);
      expect(await cashier.send({action:"refundAlertStatus",id:record.id})).toMatchObject([
        {phase:0,status:"pending"},{phase:1,status:"pending"}]);
    }
  });

  it("counts unique watch transactions by register and cashier, ignoring regular requests and retries", async () => {
    const sam={...roster[0]!,username:"sam",name:"Sam"};
    const server=app(undefined,[...roster,sam]);
    const maya=await signIn(server,"maya"), jordan=await signIn(server,"jordan"), third=await signIn(server,"sam");
    const command=(n:number,amount="34.00")=>({action:"createRefundRequest",submissionId:randomUUID(),
      terms:{reference:"TEST-MONITOR-"+n,amount,currency:"USD",reason:"Synthetic watch test"}});
    const first=command(1);
    const watch=await maya.send<RefundRequest>(first);
    expect(await maya.send(first)).toEqual(watch);
    expect(requestStatus(watch)).toBe("Blocked · Processor not connected");
    const normal=await maya.send<RefundRequest>(command(4,"2.00"));
    expect(normal.events[1]).toMatchObject({check:{monitoring:{watch:false,cashierWatchCount:0}}});
    const second=await jordan.send<RefundRequest>(command(2));
    expect(second.events[1]).toMatchObject({check:{monitoring:{cashierWatchCount:1,registerWatchCount:2}}});
    const atRegister=await third.send<RefundRequest>(command(3));
    expect(atRegister.events[1]).toMatchObject({check:{route:"manager",monitoring:{cashierWatchCount:1,registerWatchCount:3}}});
    await maya.send<RefundRequest>(command(5));
    const acrossRegisters=await maya.send<RefundRequest>(command(6));
    expect(acrossRegisters.events[1]).toMatchObject({check:{route:"manager",monitoring:{cashierWatchCount:3,registerWatchCount:1}}});
  });

  it("excludes watches exactly 15 minutes old and holds a simultaneous refund at the cumulative boundary", async () => {
    let instant=Date.parse("2026-11-21T15:00:00Z");
    const server=app(undefined,roster,()=>new Date(instant).toISOString());
    const employee=await signIn(server,"maya");
    const command=(reference:string,amount:string)=>({action:"createRefundRequest",submissionId:randomUUID(),
      terms:{reference,amount,currency:"USD",reason:"Synthetic window and concurrency"}});
    await employee.send(command("TEST-MONITOR-1","34.00"));
    instant+=1000;
    await employee.send(command("TEST-MONITOR-2","34.00"));
    instant+=899000;
    const latest=await employee.send<RefundRequest>(command("TEST-MONITOR-3","34.00"));
    expect(latest.events[1]).toMatchObject({check:{route:"routine",monitoring:{cashierWatchCount:2,registerWatchCount:2}}});
    const results=await Promise.all([employee.send<RefundRequest>(command("TEST-SALE-CASH","25.00")),
      employee.send<RefundRequest>(command("TEST-SALE-CASH","25.00"))]);
    expect(results.map(record=>requestStatus(record)).sort()).toEqual(["Needs manager decision","Ready for cash payout"]);
    expect(JSON.stringify(results)).toContain("Cumulative refunds would reach $50.00");
  });

  it("keeps synthetic drift observation separate from routing and applies the cold-start amount floor", () => {
    expect(assessSize(10000)).toEqual({z:null,absoluteHold:true,relativeHold:false,watch:false});
    expect(assessSize(5200,{median:1800,mad:500,floor:500}).z).toBeCloseTo(4.5865,3);
    expect(assessSize(3400,{median:1800,mad:0,floor:500}).z).toEqual(3.2);
    const windows=observeRefundShare([.05,.06],.05,20,10,[
      {endedAt:"1",salesAndRefunds:60,refunds:14},
      {endedAt:"2",salesAndRefunds:55,refunds:13},
      {endedAt:"3",salesAndRefunds:0,refunds:0},
    ]);
    expect(windows.map(window=>window.elevated)).toEqual([false,true,true]);
    expect(windows[2]?.eligible).toBe(false);
  });
});

describe("managed-service demonstration", () => {
  it("converts Atlanta civil time and rejects ambiguous or skipped hours", () => {
    expect(coverageInstant("2026-11-23T22:00")).toBe("2026-11-24T03:00:00.000Z");
    expect(coverageInstant("2026-07-20T22:00")).toBe("2026-07-21T02:00:00.000Z");
    expect(coverageInstant("2026-03-08T02:30")).toBeNull();
    expect(coverageInstant("2026-11-01T01:30")).toBeNull();
    expect(coverageInstant("2026-02-31T22:00")).toBeNull();
  });
  it("replays a clean overnight review without changing the normal week or prior case history", async () => {
    const now = () => "2026-11-24T14:00:00.000Z";
    const users: Employee[] = roster.map(member => ({ ...member, role: member.username === "maya" ? "cashier" : "manager" }));
    users.push({ ...users[0]!, ...overnightAccounts[0], role: "reviewer" });
    const server = app(undefined, users, now, undefined, undefined, true, true);
    const [jordan, maya, alex] = await Promise.all(["jordan", "maya", "alex"].map(username => signIn(server, username)));
    const first = randomUUID(), second = randomUUID();
    const start = (id: string) => ({ action: "startOvernightReplay", id });
    const owner = (replay?: string) => ({ action: "overnightOwner", ...(replay && { replay }) });
    const week = (replay?: string) => ({ action: "weeklyCashReview", week: "2026-11-23", location: "Harbor Fuel",
      ...(replay && { replay }) });
    const totals = async (replay: string) => {
      const groups = cashWeekGroups((await jordan!.send<CashWeek>(week(replay))).rows);
      return { short: originalVarianceTotal(groups.short), unresolved: groups.unresolved.length, rows: groups.short.length };
    };
    expect((await maya!.request(start(first))).status).toBe(403);
    expect((await alex!.request(start(first))).status).toBe(403);
    const baseline = await jordan!.send<CashWeek>(week());
    expect(await jordan!.send(start(first))).toEqual({ id: first });
    expect(await jordan!.send(start(first))).toEqual({ id: first });
    expect(await totals(first)).toEqual({ short: 1200, unresolved: 1, rows: 2 });
    expect((await jordan!.send<OvernightOwner>(owner())).cases).toEqual([]);
    const initial = await jordan!.send<OvernightOwner>(owner(first));
    const pending = initial.cases[0]!;
    expect(initial.cases).toHaveLength(1);
    expect(pending).toMatchObject({ variance: -700, responsible: "Store owner",
      progress: { handoff: { question: "Can you confirm that Maya’s first drawer count was $93.00?" } } });
    const reply = { action: "replyOvernight", id: pending.id, requestId: pending.progress!.handoff!.requestId,
      text: "I confirm Maya’s first count was $93.00." };
    await jordan!.send(reply);
    expect(await totals(first)).toEqual({ short: 1200, unresolved: 1, rows: 2 });
    const request = { action: "workspace", id: pending.id };
    const workspace = await jordan!.send<TeamWorkspaceView>(request);
    expect(workspace.cases).toEqual([]);
    expect(workspace.detail).toMatchObject({ overnightReplayId: first, case: { id: pending.id } });
    expect((await maya!.send<TeamWorkspaceView>(request)).detail).toBeNull();
    expect((await alex!.send<TeamWorkspaceView>(request)).detail).toBeNull();
    const revision = workspace.detail!.case.revision;
    await jordan!.send({ action: "resolve", id: pending.id, revision, drawerDisposition: "Closed with difference unexplained" });
    expect(await totals(first)).toEqual({ short: 1200, unresolved: 0, rows: 2 });
    await jordan!.send(start(second));
    expect(await totals(second)).toEqual({ short: 1200, unresolved: 1, rows: 2 });
    expect(await totals(first)).toEqual({ short: 1200, unresolved: 0, rows: 2 });
    expect(await jordan!.send<CashWeek>(week())).toEqual(baseline);
    const archived = server.store.open(users[1]!, pending.id);
    expect(archived).toMatchObject({ overnightReplayId: first, case: { status: "Resolved" } });
    expect(archived.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Owner replied", actor: "Jordan Lee", detail: reply.text }),
      expect.objectContaining({ kind: "Resolved", detail: "Closed with difference unexplained" }),
    ]));
    expect((await jordan!.send<OvernightOwner>(owner(second))).replays.map(run => run.id)).toEqual([second, first]);
  });

  it("claims one open drawer case, keeps the owner handoff, and revokes expired access", async () => {
    let now = "2026-11-24T02:59:00.000Z";
    const clock = () => now;
    const users: Employee[] = roster.map(member => ({ ...member, role: member.username === "maya" ? "cashier" : "manager" }));
    for (const account of overnightAccounts) {
      const salt = randomBytes(16);
      users.push({ username: account.username, name: account.name, merchantName: "Harbor Goods", merchantId: "harbor",
        role: "reviewer", salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") });
    }
    const server = app(undefined, users, clock, undefined, undefined, true, true);
    const cashier = await signIn(server, "maya");
    const owner = await signIn(server, "jordan");
    const ivy = await signIn(server, "ivy-night");
    const noah = await signIn(server, "noah-night");
    const sam = await signIn(server, "sam-night");
    const outsider = await signIn(server, "alex");
    const cases: string[] = [];
    const drawerIds: string[] = [];
    for (const count of [9500, 9300, 9600]) {
      const drawer = randomUUID();
      await cashier.send({ action: "openCashDrawer", id: drawer, cents: 10000 });
      await cashier.send({ action: "closeCashDrawer", id: drawer, cents: count });
      const result = await owner.send<CashDrawerView>({ action: "openDrawerCase", id: drawer });
      cases.push(result.drawer!.report!.caseId!);
      drawerIds.push(drawer);
    }
    const db = new DatabaseSync(server.path);
    db.prepare("UPDATE team_cash_drawers SET location=?, register=? WHERE merchant_id=? AND id=?")
      .run("Harbor Bar", "Bar 1", "harbor", drawerIds[2]!);
    db.close();
    const id = cases[1]!;
    const desk = { action: "overnightDesk", id };
    const claim = { action: "claimOvernightCase", id };
    expect((await ivy.request(desk)).status).toBe(403);
    expect((await sam.request({ action: "overnightDesk" })).status).toBe(403);
    expect((await outsider.request({ action: "overnightOwner" })).status).toBe(403);
    const scheduled = { action: "grantCoverage", id: randomUUID(), location: "Harbor Fuel", reviewer: "ivy-night",
      start: "2026-11-23T22:00", end: "2026-11-24T06:00" };
    expect((await cashier.request(scheduled)).status).toBe(403);
    expect((await outsider.request(scheduled)).status).toBe(403);
    expect((await owner.request({ ...scheduled, reviewer: "alex" })).status).toBe(403);
    expect((await owner.request({ ...scheduled, location: "Unknown Store" })).status).toBe(403);
    expect((await owner.request({ ...scheduled, end: "2026-11-23T21:59" })).status).toBe(422);
    expect((await owner.send<CoverageSettingsView>(scheduled)).grants[0]).toMatchObject({
      status: "Scheduled", grantedBy: "Jordan Lee", startsAt: "2026-11-24T03:00:00.000Z", endsAt: "2026-11-24T11:00:00.000Z",
    });
    expect((await owner.send<CoverageSettingsView>(scheduled)).grants).toHaveLength(1);
    expect((await owner.request({ ...scheduled, id: randomUUID() })).status).toBe(409);
    expect((await ivy.request(desk)).status).toBe(403);
    await owner.send({ ...scheduled, id: randomUUID(), reviewer: "noah-night" });
    now = "2026-11-24T03:00:00.000Z";
    expect((await ivy.request(desk)).status).toBe(200);
    now = "2026-11-24T05:01:00.000Z";
    expect((await ivy.send<OvernightQueue>({ action: "overnightDesk" })).cases.map(item => item.id).sort()).toEqual(cases.slice(0, 2).sort());
    expect((await ivy.request({ action: "overnightDesk", id: cases[2] })).status).toBe(404);
    expect((await sam.request(desk)).status).toBe(403);
    expect((await sam.send<TeamWorkspaceView>({ action: "workspace", id })).detail).toBeNull();
    expect((await ivy.send<TeamWorkspaceView>({ action: "workspace", id })).detail).toBeNull();
    expect((await ivy.request({ action: "decideRefundRequest", id, decision: "Approved", password })).status).toBe(403);
    const evidence = await ivy.send<OvernightQueue>(desk);
    expect(evidence.detail?.evidence.report).toMatchObject({ expected: 10000, firstCount: { cents: 9300 } });
    expect(evidence.detail?.variance).toBe(-700);
    const racers = [ivy, noah];
    const results = await Promise.all(racers.map(user => user.request(claim)));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = racers[results.findIndex(result => result.ok)]!;
    const claimed = await winner.send<NonNullable<OvernightQueue["detail"]>>(claim);
    const requestId = randomUUID();
    const ask = { action: "requestOvernightFollowUp", id, grantId: claimed.progress?.claimant?.grantId, requestId, checked: "Compared drawer entries with the first count.",
      question: "Can you verify the closing count?" };
    await winner.send(ask);
    await winner.send(ask);
    expect((await owner.send<OvernightOwner>({ action: "overnightOwner" })).cases[0]?.progress?.handoff)
      .toMatchObject({ actor: winner.user.name, question: ask.question });
    const reply = { action: "replyOvernight", id, requestId, text: "I will ask the closer to verify." };
    await owner.send(reply);
    await owner.send(reply);
    const week = await owner.send<CashWeek>({ action: "weeklyCashReview", week: "2026-11-23" });
    expect(week.rows.filter(row => row.location === "Harbor Fuel").map(row => row.close?.variance).sort()).toEqual([-500, -700]);
    expect(week.rows.find(row => row.close?.review?.id === id)?.close?.review?.status).toBe("Investigating");
    const nextAsk = { ...ask, requestId: randomUUID(), question: "Can you verify the closing count with Maya?" };
    await winner.send(nextAsk);
    now = "2026-11-24T11:00:00.000Z";
    expect((await winner.request(ask)).status).toBe(403);
    expect((await winner.request(desk)).status).toBe(403);
    expect((await owner.send<CoverageSettingsView>({ action: "coverageSettings" })).grants.every(grant => grant.status === "Ended")).toBe(true);
    const demo = { action: "startDemoCoverage", id: randomUUID(), reviewer: winner.user.username, location: "Harbor Fuel" };
    expect((await owner.send<CoverageSettingsView>(demo)).grants[0]?.status).toBe("Active");
    expect((await winner.request(desk)).status).toBe(200);
    expect((await winner.request({ action: "revokeCoverage", id: demo.id })).status).toBe(403);
    const revoked = await owner.send<CoverageSettingsView>({ action: "revokeCoverage", id: demo.id });
    expect(revoked.grants[0]).toMatchObject({ status: "Revoked", revokedBy: "Jordan Lee", revokedAt: now });
    expect((await winner.request({ ...ask, requestId: randomUUID(), question: "Stale note" })).status).toBe(403);
    await owner.send({ ...reply, requestId: nextAsk.requestId });
    server.stop();
    const restored = app(server.path, users, clock, undefined, undefined, true, true);
    const original = await restored.request({ action: "workspace", id }, owner.key);
    const { detail } = await original.json() as TeamWorkspaceView;
    expect(detail?.case.status).toBe("Investigating");
    expect(detail?.history.map(event => event.kind)).toEqual([
      "Opened", "Coverage claimed", "Owner follow-up requested", "Owner replied", "Owner follow-up requested", "Reviewer shift ended", "Owner replied",
    ]);
    const restoredOwner = await restored.request({ action: "overnightOwner" }, owner.key,
      { sessionVersion: owner.user.sessionVersion });
    const restoredSettings = await restored.request({ action: "coverageSettings" }, owner.key,
      { sessionVersion: owner.user.sessionVersion });
    expect(await restoredSettings.json()).toMatchObject({ grants: [
      { id: demo.id, status: "Revoked" }, { status: "Ended" }, { status: "Ended" },
    ] });
    expect(await restoredOwner.json()).toMatchObject({ cases: [
      { id, progress: { handoff: { question: nextAsk.question, reply: { text: reply.text } } } },
    ] });
  });

  it("returns an investigation exactly once on startup and reassigns the same open case", async () => {
    let now = "2026-11-24T10:59:00.000Z";
    const clock = () => now;
    const users: Employee[] = roster.map(member => ({ ...member, role: member.username === "maya" ? "cashier" : "manager" }));
    for (const account of overnightAccounts) {
      const salt = randomBytes(16);
      users.push({ ...account, merchantName: "Harbor Goods", merchantId: "harbor", role: "reviewer",
        salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") });
    }
    const server = app(undefined, users, clock, undefined, undefined, true, true);
    const owner = await signIn(server, "jordan");
    const cashier = await signIn(server, "maya");
    const first = await signIn(server, "ivy-night");
    const next = await signIn(server, "noah-night");
    const drawerCase = async (cents: number) => {
      const drawer = randomUUID();
      await cashier.send({ action: "openCashDrawer", id: drawer, cents: 10000 });
      await cashier.send({ action: "closeCashDrawer", id: drawer, cents });
      const item = await owner.send<CashDrawerView>({ action: "openDrawerCase", id: drawer });
      return item.drawer!.report!.caseId!;
    };
    const id = await drawerCase(9300);
    const closed = await drawerCase(9500);
    const ending = randomUUID();
    await owner.send({ action: "grantCoverage", id: ending, location: "Harbor Fuel", reviewer: "ivy-night",
      start: "2026-11-23T22:00", end: "2026-11-24T06:00" });
    await owner.send({ action: "grantCoverage", id: randomUUID(), location: "Harbor Fuel", reviewer: "noah-night",
      start: "2026-11-24T06:00", end: "2026-11-24T14:00" });
    await owner.send({ action: "startDemoCoverage", id: randomUUID(), location: "Harbor Bar", reviewer: "sam-night" });
    await first.send({ action: "claimOvernightCase", id });
    await first.send({ action: "claimOvernightCase", id: closed });
    await owner.send({ action: "record", id: closed, revision: 1, finding: "Reviewed count", nextAction: "Close as unexplained",
      status: "Investigating" });
    await owner.send({ action: "resolve", id: closed, revision: 2, drawerDisposition: "Closed with difference unexplained" });
    const ownerCommand = { action: "overnightOwner" };
    const before = await owner.send<OvernightOwner>(ownerCommand);
    expect(before.cases).toHaveLength(1);
    expect(before.cases[0]).toMatchObject({ id, responsible: "Ivy Brooks", variance: -700 });
    expect((await next.request({ action: "overnightDesk", id })).status).toBe(403);
    server.stop();

    now = "2026-11-24T11:00:00.000Z";
    const restarted = app(server.path, users, clock, undefined, undefined, true, true);
    const send = (command: unknown, person = owner) =>
      restarted.request(command, person.key, { sessionVersion: person.user.sessionVersion });
    const readCase = async (caseId: string) => {
      const response = await send({ action: "workspace", id: caseId });
      return (await response.json() as TeamWorkspaceView).detail!;
    };
    const handoff = (await readCase(id)).history.filter(event => event.kind === "Reviewer shift ended");
    expect(handoff).toHaveLength(1);
    expect(handoff[0]).toMatchObject({ occurredAt: now, detail: expect.stringContaining("Ivy Brooks") });
    const after = await (await send(ownerCommand)).json() as OvernightOwner;
    expect(after.cases).toHaveLength(1);
    expect(after.cases[0]).toMatchObject({ id, responsible: "Store owner", lastAction: { kind: "Coverage claimed" },
      eligible: [{ username: "noah-night", name: "Noah Reed" }] });
    expect((await readCase(closed)).case.status).toBe("Resolved");
    expect((await readCase(closed)).history.some(event => event.kind === "Reviewer shift ended")).toBe(false);
    const stale = { action: "requestOvernightFollowUp", id, grantId: ending, requestId: randomUUID(), checked: "Count",
      question: "Please verify $93" };
    expect((await send(stale, first)).status).toBe(403);
    expect((await send({ action: "claimOvernightCase", id }, next)).status).toBe(409);
    const assign = { action: "reassignOvernightCase", id, endedAt: now, reviewer: "noah-night" };
    expect((await send({ ...assign, reviewer: "sam-night" })).status).toBe(409);
    expect((await send({ ...assign, reviewer: "ivy-night" })).status).toBe(409);
    const assigned = await (await send(assign)).json() as OvernightOwner;
    expect(assigned.cases[0]).toMatchObject({ id, responsible: "Noah Reed", lastAction: { kind: "Coverage reassigned" } });
    expect((await send(assign)).status).toBe(409);
    expect((await readCase(id)).history.filter(event => event.kind === "Reviewer shift ended")).toHaveLength(1);
    expect((await readCase(id)).history.filter(event => event.kind === "Coverage reassigned")).toHaveLength(1);
    const week = await (await send({ action: "weeklyCashReview", week: "2026-11-23" })).json() as CashWeek;
    expect(week.rows.map(row => row.close?.variance).sort()).toEqual([-500, -700]);
  });

});

describe("read-only closed-week pilot", () => {
  it("scores three flags and one missed issue and deduplicates uploads across reset and restart", async () => {
    const users: Employee[] = roster.map(member => ({ ...member, role: member.username === "maya" ? "cashier" : "manager" }));
    const clock = () => "2026-11-23T15:00:00.000Z";
    const server = app(undefined, users, clock, undefined, undefined, true);
    const owner = await signIn(server,"jordan");
    const outsider = await signIn(server,"alex");
    const cashier = await signIn(server,"maya");
    const start = { action:"startPilot", location:"Harbor Fuel", register:"Register 1", week:"2026-11-16",
      timeZone:"America/New_York", synthetic:true };
    expect((await cashier.request(start)).status).toBe(403);
    expect((await owner.request({...start,week:"2026-11-23"})).status).toBe(422);
    expect((await owner.request({...start,week:"2026-11-17"})).status).toBe(422);
    expect((await owner.request({...start,timeZone:"Not a zone"})).status).toBe(422);
    const pilot = await owner.send<PilotView>(start);
    const id = pilot.scope.id;
    const open = { action:"openPilot",id };
    expect((await owner.send<PilotView>(start)).scope.id).toBe(id);
    expect(pilot.scope.end).toBe("2026-11-22");
    expect(pilot.savedMinutes).toBeNull();
    expect((await outsider.request(open)).status).toBe(404);
    expect(await outsider.send({action:"listPilots"})).toEqual([]);
    const mapping={reference:0,amount:1,currency:2,status:3};
    const header="refund_reference,refund_amount,currency,status";
    const merchant=[header,"P-amount,15,USD,COMPLETED","P-timing,20,USD,COMPLETED",
      "P-missed,8,USD,PENDING","P-unresolved,25,USD,COMPLETED",",5,USD,COMPLETED"].join("\n");
    const processor=[header,"P-amount,17,USD,COMPLETED","P-missed,8,USD,COMPLETED","P-unresolved,22,USD,COMPLETED"].join("\n");
    const file = (source:string,text:string) => ({action:"attachPilotFile",id,source,scopeConfirmed:true,
      file:{name:source+".csv",text,mapping}});
    const inspect = await owner.send<{rowCount:number}>({action:"inspectPilotCsv",text:merchant});
    expect(inspect.rowCount).toBe(5);
    const worksheet = await owner.send<PilotView>(file("Merchant",merchant));
    expect(worksheet.sources).toMatchObject([{side:"Merchant",accepted:4,rejected:[{line:6}]}]);
    expect(worksheet.comparisonReady).toBe(false);
    expect(worksheet.score).toBeNull();
    expect((await owner.request({action:"revealPilot",id})).status).toBe(409);
    expect((await owner.request({action:"savePilotBaseline",id,minutes:null,exceptions:null})).status).toBe(422);
    const baseline={action:"savePilotBaseline",id,minutes:24,exceptions:["P-amount amount differs","P-missed status differs"]};
    expect((await owner.send<PilotView>(baseline)).baseline?.beforeFindings).toBe(true);
    expect((await owner.request({...baseline,minutes:3})).status).toBe(409);
    const ready=await owner.send<PilotView>(file("Processor",processor));
    expect(ready.comparisonReady).toBe(true);
    expect(ready.issues).toHaveLength(0);
    const revealed=await owner.send<PilotView>({action:"revealPilot",id});
    expect(revealed.score).toMatchObject({flags:3,decided:0,unresolved:3});
    expect(revealed.exact).toBe(1);
    const issue=(reference:string)=>revealed.issues.find(item=>item.rows[0]?.reference===reference)!;
    expect((await cashier.request({action:"workspace",id:issue("P-amount").id})).status).toBe(200);
    const hidden=await cashier.send<TeamWorkspaceView>({action:"workspace",id:issue("P-amount").id});
    expect(hidden.detail).toBeNull();
    expect(hidden.cases.some(item=>item.id===issue("P-amount").id)).toBe(false);
    const decide=(caseId:string,outcome:string,revision=0)=>({action:"decidePilotIssue",id,caseId,outcome,note:"Reviewed by finance",revision});
    await owner.send(decide(issue("P-amount").id,"confirmed"));
    await owner.send(decide(issue("P-timing").id,"incorrect flag"));
    await owner.send(decide(issue("P-unresolved").id,"unresolved"));
    expect((await owner.request(decide(issue("P-amount").id,"incorrect flag"))).status).toBe(409);
    const miss={action:"addPilotMiss",id,reference:"P-missed",note:"Register still showed pending."};
    await owner.send(miss);
    await owner.send(miss);
    expect((await owner.request({...miss,reference:"unknown"})).status).toBe(422);
    await owner.send({action:"savePilotTime",id,review:12,setup:5,waiting:30});
    const saved = await owner.send<PilotView>({action:"savePilotDecision",id,decision:"continue",note:"Repeat independently."});
    expect(saved.score).toEqual({confirmed:1,incorrect:1,unresolved:1,missed:1,flags:3,decided:2});
    expect(saved.savedMinutes).toBe(12);
    expect(saved.issues.find(item=>item.outcome==="missed")?.rows.map(row=>row.side)).toEqual(["Merchant","Processor"]);
    expect(saved.decision?.value).toBe("continue");
    const report = pilotSummaryText({ ...saved, time: { ...saved.time, waiting: null } });
    expect(report).toContain("SYNTHETIC ACCEPTANCE RUN");
    expect(report).toContain("Confirmed among decided ChangeGate flags: 1 of 2");
    expect(report).toContain("Waiting: Unmeasured");
    expect(report).toContain("Owner decision: continue");
    for (const privateValue of ["P-missed", "P-amount", "Jordan Lee", "Reviewed by finance", "Harbor Fuel", "Repeat independently."]) {
      expect(report).not.toContain(privateValue);
    }
    await owner.send(file("Merchant",merchant));
    await owner.send(file("Processor",processor));
    await owner.send({action:"revealPilot",id});
    expect((await owner.send<PilotView>(open)).issues).toEqual(saved.issues);
    expect((await owner.request(file("Merchant",merchant.replace("15,USD","18,USD")))).status).toBe(409);
    const demo = await cashier.send<{state:DemoState}>({action:"startDemoShift",seed:"harbor-evening"});
    await cashier.send({action:"replayDemoShift",runId:demo.state.runId});
    expect((await owner.send<PilotView>(open)).issues).toEqual(saved.issues);
    server.stop();
    const restarted=app(server.path,users,clock,undefined,undefined,true, true);
    const restored=await restarted.request(open,owner.key,{sessionVersion:owner.user.sessionVersion});
    expect(await restored.json()).toEqual(saved);
  });

  it("labels a late baseline and leaves time savings unmeasured", async () => {
    const users: Employee[] = roster.map(member => ({ ...member, role:"manager" }));
    const server = app(undefined, users, () => "2026-11-23T15:00:00.000Z", undefined, undefined, true);
    const owner=await signIn(server,"jordan");
    const pilot=await owner.send<PilotView>({action:"startPilot",location:"Harbor Fuel",register:"Register 1",
      week:"2026-11-16",timeZone:"America/New_York",synthetic:true});
    const id=pilot.scope.id;
    for(const source of ["Merchant","Processor"]) await owner.send({action:"attachPilotFile",id,source,scopeConfirmed:true,
      file:{name:source+".csv",text:"reference,amount,currency\nexact,4,USD",mapping:{reference:0,amount:1,currency:2}}});
    await owner.send({action:"revealPilot",id});
    await owner.send({action:"savePilotBaseline",id,minutes:25,exceptions:[]});
    const saved=await owner.send<PilotView>({action:"savePilotTime",id,review:10,setup:null,waiting:null});
    expect(saved.baseline?.beforeFindings).toBe(false);
    expect(saved.savedMinutes).toBeNull();
    expect(pilotSummaryText(saved)).toContain("Confirmed among decided ChangeGate flags: Unmeasured");
    expect(pilotSummaryText(saved)).toContain("ChangeGate setup: Unmeasured");
  });
});

it("hosted pilot accepts only server-bundled fictional files", async () => {
  const users: Employee[] = roster.map(user => ({...user, role:"manager"}));
  const server = app(undefined, users, () => "2026-11-23T15:00:00.000Z", undefined, undefined, true, true);
  const owner = await signIn(server,"jordan");
  const {scope} = await owner.send<PilotView>({action:"startPilot",location:"Harbor Fuel",register:"Register 1",week:"2026-11-16",
    timeZone:"America/New_York",synthetic:true});
  const marker = "LOCAL-BOUNDARY-UNIT-CHECK";
  const file = {name:"source.csv",text:"reference,amount,currency\n"+marker+",10,USD",mapping:{reference:0,amount:1,currency:2}};
  const open = {action:"openPilot",id:scope.id};
  const raw = [
    {action:"inspectPilotCsv",text:file.text},
    {action:"attachPilotFile",id:scope.id,source:"Merchant",scopeConfirmed:true,file},
  ];
  for(const command of raw) {
    const denied = await owner.request(command);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({error:"PILOT_SYNTHETIC_ONLY"});
  }
  const legacy = [
    {action:"inspectCsv",text:file.text},
    {action:"previewCsv",text:file.text,mapping:file.mapping},
    {action:"importCsv",text:file.text,mapping:file.mapping},
    ...["previewComparison","saveComparison"].map(action=>({action,input:{merchant:file,processor:file,
      period:{start:scope.week,end:scope.end}}})),
  ];
  for(const command of legacy) expect((await owner.request(command)).status).toBe(404);
  const load = {action:"loadFictionalPilotFile",id:scope.id,source:"Merchant"};
  expect((await owner.request({...load,file})).status).toBe(400);
  expect((await owner.send<PilotView>(open)).sources).toEqual([]);
  const register = await owner.send<PilotView>(load);
  expect(register.sources).toMatchObject([{name:"fictional-register.csv",accepted:4}]);
  expect(register.comparisonReady).toBe(false);
  await owner.send({...load,source:"Processor"});
  const compared = await owner.send<PilotView>({action:"revealPilot",id:scope.id});
  expect(compared.score).toMatchObject({flags:3,unresolved:3});
  expect(JSON.stringify(compared)).not.toContain(marker);
});
