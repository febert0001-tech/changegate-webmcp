import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDecisionReceipt } from "../src/application/read-decision-receipt";
import type { MerchantCapture, MerchantCaseDetail, MerchantCommand } from "../src/merchant/contracts";
import { createMerchantHandler } from "../src/merchant/handler";
import { PayPalMerchantSandbox, type SandboxTransport } from "../src/merchant/paypal-sandbox";
import { merchantReceipt } from "../src/merchant/receipt";
import { MerchantRefunds } from "../src/merchant/service";
import { demoMerchant, simulatedSandbox } from "../src/merchant/simulation";
import { MerchantStore } from "../src/merchant/store";
import { merchantWebMcp } from "../src/merchant/webmcp";
import { GATE_2_TOOL_NAMES } from "../src/webmcp/tool-catalog";

const origin = "http://127.0.0.1:3190";
const password = "local-fixture-password";
const authorization = "Basic " + Buffer.from("reviewer:" + password).toString("base64");
const stores = new Set<MerchantStore>();
const dirs: string[] = [];

function database() {
  const dir = mkdtempSync(join(tmpdir(), "changegate-merchant-"));
  dirs.push(dir);
  return join(dir, "merchant.sqlite");
}

function app(path = database(), config: {
  merchantId?: string; limit?: number; execute?: boolean;
  inject?: (transport: SandboxTransport) => SandboxTransport;
} = {}) {
  const merchantId = config.merchantId ?? demoMerchant;
  const cap = config.limit ?? 10_000;
  const store = new MerchantStore(path, merchantId, "simulated");
  stores.add(store);
  const fake = simulatedSandbox(store);
  const provider = new PayPalMerchantSandbox({ merchantId, clientId: "client", clientSecret: "secret", maxRefundCents: cap },
    config.inject?.(fake) ?? fake);
  const service = new MerchantRefunds(store, provider, "Simulated PayPal Sandbox", cap);
  const handle = createMerchantHandler(service, { origin, operator: "reviewer", password, executionEnabled: config.execute ?? true });
  function command(input: unknown, credential = authorization, requestOrigin = origin) {
    return handle(new Request(origin + "/api/merchant", {
      method: "POST", headers: { Origin: requestOrigin, Authorization: credential, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
  }
  async function ok<T>(input: MerchantCommand): Promise<T> {
    const response = await command(input);
    if (!response.ok) throw new Error(JSON.stringify(await response.json()));
    return response.json() as Promise<T>;
  }
  return { command, ok, store, path };
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  const root = resolve(tmpdir());
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== root) throw Error("Unexpected test directory");
    rmSync(path, { recursive: true, force: true });
  }
});

async function proposal(instance: ReturnType<typeof app>, captureId: string, amountCents: number | null) {
  return (await instance.ok<MerchantCaseDetail>({ action: "propose", captureId, amountCents })).case;
}

async function approved(instance: ReturnType<typeof app>, captureId: string, amountCents: number | null) {
  const row = await proposal(instance, captureId, amountCents);
  await instance.ok({ action: "review", id: row.id, version: row.version });
  await instance.ok({ action: "decide", id: row.id, version: row.version, decision: "approve" });
  return { id: row.id, version: row.version };
}

describe("merchant refunds through the authenticated application handler", () => {
  it("locates a capture by order and executes a full refund from its remaining balance", async () => {
    const instance = app();
    const [capture] = await instance.ok<MerchantCapture[]>({ action: "find", kind: "order", reference: "DEMOORDER100" });
    expect(capture).toMatchObject({ captureId: "DEMOCAPTURE100", amountCents: 1899, remainingCents: 1899 });
    const intent = await approved(instance, "DEMOCAPTURE100", null);
    const result = await instance.ok<MerchantCaseDetail>({ action: "execute", ...intent });
    expect(result.case).toMatchObject({
      amountCents: 1899, status: "COMPLETED", reviewer: "reviewer",
      observation: { amountCents: 1899, status: "COMPLETED", captureId: "DEMOCAPTURE100" },
    });
    const receipt = merchantReceipt(result, "Simulated PayPal Sandbox");
    expect(readDecisionReceipt(JSON.stringify(receipt))?.verification.status).toBe("VERIFIED");
    expect(receipt.verification.source).toBe("SIMULATED_PROVIDER_GET");
    expect(JSON.stringify(receipt)).not.toMatch(/invoiceId|requestId|authorization|local-fixture-password/i);
  });

  it("subtracts prior partial refunds and finishes with the remaining amount", async () => {
    const instance = app();
    const first = await approved(instance, "DEMOCAPTURE200", 1328);
    await instance.ok({ action: "execute", ...first });
    const [snapshot] = await instance.ok<MerchantCapture[]>({ action: "find", kind: "capture", reference: "DEMOCAPTURE200" });
    expect(snapshot).toMatchObject({ remainingCents: 5907, refunds: [{ amountCents: 1328 }] });
    const second = await approved(instance, "DEMOCAPTURE200", 1704);
    await instance.ok({ action: "execute", ...second });
    const excess = await instance.command({ action: "propose", captureId: "DEMOCAPTURE200", amountCents: 4204 });
    expect(await excess.json()).toEqual({ error: "REFUND_EXCEEDS_REMAINING_BALANCE" });
    const rest = await approved(instance, "DEMOCAPTURE200", null);
    expect((await instance.ok<MerchantCaseDetail>({ action: "execute", ...rest })).case.amountCents).toBe(4203);
  });

  it("checks operator identity, origin, merchant ownership, proposal version, and the server policy", async () => {
    const instance = app(database(), { limit: 1500 });
    expect((await instance.command({ action: "queue" }, "Basic invalid")).status).toBe(401);
    expect((await instance.command({ action: "queue" }, authorization, "https://foreign.example")).status).toBe(403);
    const foreign = app(database(), { merchantId: "OTHERCOMPANY" });
    expect((await foreign.command({ action: "find", kind: "order", reference: "DEMOORDER100" })).status).toBe(404);
    expect((await foreign.command({ action: "propose", captureId: "DEMOCAPTURE100", amountCents: 500 })).status).toBe(404);
    const limit = await instance.command({ action: "propose", captureId: "DEMOCAPTURE100", amountCents: 1501 });
    expect(await limit.json()).toEqual({ error: "REFUND_POLICY_LIMIT" });
    const row = await proposal(instance, "DEMOCAPTURE100", 1210);
    expect((await instance.command({ action: "execute", id: row.id, version: row.version, approved: true })).status).toBe(400);
    expect((await instance.command({ action: "review", id: row.id, version: row.version + 1 })).status).toBe(409);
    await instance.ok({ action: "review", id: row.id, version: row.version });
    const detail = await instance.ok<MerchantCaseDetail>({ action: "decide", id: row.id, version: row.version, decision: "reject" });
    expect(detail.case.status).toBe("REJECTED");
    expect((await instance.command({ action: "execute", id: row.id, version: row.version })).status).toBe(409);
    expect(instance.store.db.prepare("SELECT count(*) n FROM simulated_provider_refunds").get()?.n).toBe(0);
  });

  it("reserves balance once across competing workers and duplicate Execute", async () => {
    const instance = app();
    const other = app(instance.path);
    const one = await approved(instance, "DEMOCAPTURE200", 4100);
    const two = await approved(other, "DEMOCAPTURE200", 4000);
    const responses = await Promise.all([
      instance.command({ action: "execute", ...one }),
      other.command({ action: "execute", ...one }),
      other.command({ action: "execute", ...two }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
    expect(instance.store.db.prepare("SELECT count(*) n FROM simulated_provider_refunds").get()?.n).toBe(1);
  });

  it.each([
    ["DEMOCAPTURE400", "PENDING", null],
    ["DEMOCAPTURE500", "UNCERTAIN", "REFUND_READBACK_MISMATCH"],
    ["DEMOCAPTURE600", "FAILED", "PROVIDER_REFUND_FAILED"],
  ] as const)("keeps %s as %s with evidence and no verified receipt", async (captureId, status, issue) => {
    const instance = app();
    const intent = await approved(instance, captureId, 867);
    const detail = await instance.ok<MerchantCaseDetail>({ action: "execute", ...intent });
    expect(detail.case).toMatchObject({ status, issue });
    expect(merchantReceipt(detail, "Simulated PayPal Sandbox").verification.status).not.toBe("VERIFIED");
    expect(await instance.ok({ action: "queue" })).toMatchObject([{ id: intent.id, status }]);
  });

  it("reopens a lost response without a second submission and reconciles the original invoice", async () => {
    const instance = app();
    const intent = await approved(instance, "DEMOCAPTURE300", 1237);
    const first = await instance.ok<MerchantCaseDetail>({ action: "execute", ...intent });
    const attempt = instance.store.get(intent.id);
    expect(first.case).toMatchObject({ status: "UNCERTAIN", refundId: null, issue: "SUBMISSION_RESPONSE_UNAVAILABLE" });
    expect(attempt.request_id).toMatch(/^[a-f0-9-]{36}$/);
    stores.delete(instance.store);
    instance.store.close();
    const restarted = app(instance.path);
    expect((await restarted.ok<MerchantCaseDetail>({ action: "case", id: intent.id })).case.status).toBe("UNCERTAIN");
    expect((await restarted.command({ action: "execute", ...intent })).status).toBe(409);
    const recovered = await restarted.ok<MerchantCaseDetail>({ action: "reconcile", id: intent.id });
    expect(recovered.case).toMatchObject({ status: "COMPLETED", observation: { amountCents: 1237, status: "COMPLETED" } });
    expect(restarted.store.get(intent.id).request_id).toBe(attempt.request_id);
    expect(restarted.store.db.prepare("SELECT count(*) n FROM simulated_provider_refunds").get()?.n).toBe(1);
  });

  it("preserves a submission reservation if a worker has not returned from the provider POST", async () => {
    let accepted!: () => void;
    const observed = new Promise<void>((done) => { accepted = done; });
    let release!: () => void;
    const paused = new Promise<void>((done) => { release = done; });
    const first = app(database(), {
      inject: (fake) => async (url, init) => {
        if (!url.endsWith("/refund")) return fake(url, init);
        try { return await fake(url, init); }
        finally { accepted(); await paused; }
      },
    });
    const intent = await approved(first, "DEMOCAPTURE300", 623);
    const executing = first.ok<MerchantCaseDetail>({ action: "execute", ...intent });
    await observed;
    try {
      const restarted = app(first.path);
      expect((await restarted.ok<MerchantCaseDetail>({ action: "case", id: intent.id })).case)
        .toMatchObject({ status: "SUBMITTED", refundId: null });
      expect((await restarted.command({ action: "execute", ...intent })).status).toBe(409);
      expect((await restarted.ok<MerchantCaseDetail>({ action: "reconcile", id: intent.id })).case.status).toBe("COMPLETED");
      expect(restarted.store.db.prepare("SELECT count(*) n FROM simulated_provider_refunds").get()?.n).toBe(1);
    } finally {
      release();
      await executing;
    }
  });

  it("escalates an undiscoverable refund and refuses a candidate from a different capture", async () => {
    const instance = app();
    const intent = await approved(instance, "DEMOCAPTURE700", 1400);
    await instance.ok({ action: "execute", ...intent });
    const unknown = await instance.ok<MerchantCaseDetail>({ action: "reconcile", id: intent.id });
    expect(unknown.case).toMatchObject({ status: "UNCERTAIN", issue: "ORIGINAL_REFUND_NOT_LOCATED", refundId: null });
    const unrelated = await approved(instance, "DEMOCAPTURE200", 1400);
    const other = await instance.ok<MerchantCaseDetail>({ action: "execute", ...unrelated });
    if (!other.case.refundId) throw Error("Expected unrelated refund reference");
    const conflict = await instance.ok<MerchantCaseDetail>({ action: "reconcile", id: intent.id, refundId: other.case.refundId });
    expect(conflict.case).toMatchObject({ status: "UNCERTAIN", refundId: null, observation: null });
    const blocked = await instance.command({ action: "propose", captureId: "DEMOCAPTURE700", amountCents: 100 });
    expect(await blocked.json()).toEqual({ error: "REFUND_HISTORY_UNCERTAIN" });
    expect(instance.store.db.prepare("SELECT count(*) n FROM simulated_provider_refunds WHERE capture_id=?").get("DEMOCAPTURE700")?.n)
      .toBe(1);
  });

  it("blocks provider submission when disabled and exposes only seven inspect/propose WebMCP tools", async () => {
    const instance = app(database(), { execute: false });
    const intent = await approved(instance, "DEMOCAPTURE100", 529);
    expect(await (await instance.command({ action: "execute", ...intent })).json()).toEqual({
      error: "SANDBOX_EXECUTION_DISABLED",
    });
    const tools = merchantWebMcp((input) => instance.ok(input), { maxRefundCents: 10_000 });
    expect(tools.map(({ name }) => name)).toEqual(GATE_2_TOOL_NAMES);
    const tool = tools.find(({ name }) => name === "propose_change");
    if (!tool) throw Error("Missing proposal tool");
    const context = { signal: new AbortController().signal };
    expect(await tool.execute({ captureId: "DEMOCAPTURE100", amountCents: 577, approved: true }, context))
      .toEqual({ status: "INVALID_INPUT" });
    expect(await tool.execute({ captureId: "DEMOCAPTURE100", amountCents: 577 }, context))
      .toMatchObject({ status: "SUCCESS", data: { case: { status: "PROPOSED", decision: null } } });
  });
});
