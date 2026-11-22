import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessSize, observeRefundShare } from "../src/merchant-team/refund-monitor-rules";
import { requestStatus, requestReceipt, type RefundRequest } from "../src/merchant-team/refund-requests";
import type { Employee, TeamCase, TeamCaseDetail, TeamSession, TeamWorkspaceView } from "../src/merchant-team/contracts";
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

function app(path?: string, users = roster, clock?: () => string, square?: SquareSandbox, paypal?: PayPalProvider) {
  if (!path) {
    const folder = mkdtempSync(join(tmpdir(), "changegate-team-"));
    folders.push(folder);
    path = join(folder, "merchant.sqlite");
  }
  const store = new TeamStore(path, clock);
  stores.add(store);
  const workspace = createTeamWorkspace(store, users, origin, { ...(square && { square }), ...(paypal && { paypal }) });
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
      failMerchantRead: 0, denyRefund: false, rejectionCode: "INSUFFICIENT_PERMISSIONS_FOR_REFUND", beforePaymentRead: async () => {} };
    let merchantReads = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://connect.squareupsandbox.com");
      if (url.pathname === "/v2/merchants/me") {
        return ++merchantReads === settings.failMerchantRead ? new Response(null, { status: 503 }) :
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
    return { square: new SquareSandbox(config, transport), settings, posts, ledger };
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
    const squareSubmit = vi.spyOn(mock.square, "submit").mockImplementationOnce(attempt => {
      // An external $50 refund posts after the final provider lookup on the $120 sale.
      mock.settings.refundIds = ["earlier-refund"];
      mock.settings.priorRefundStatus = "PENDING";
      return submitToSquare(attempt);
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
    clock = started + cutoff + 1;
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
      beforeSubmit: async () => {}, beforeCaptureRead: async () => {}, unreadableRefund: "" };
    const transport = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://api-m.sandbox.paypal.com");
      const money = (value: string) => ({ value, currency_code: "USD" });
      if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "fixture-bearer", token_type: "Bearer", expires_in: 120 });
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
