import { randomUUID } from "node:crypto";
import { parseUsd } from "./contracts";
import { sandboxOrigin, type SandboxTransport } from "./paypal-sandbox";
import type { MerchantStore } from "./store";

export const demoMerchant = "DEMOMERCHANT1";
export const demoCaptures = [
  { orderId: "DEMOORDER100", captureId: "DEMOCAPTURE100", amountCents: 1899, fault: "none" },
  { orderId: "DEMOORDER200", captureId: "DEMOCAPTURE200", amountCents: 7235, fault: "none" },
  { orderId: "DEMOORDER300", captureId: "DEMOCAPTURE300", amountCents: 3491, fault: "lost" },
  { orderId: "DEMOORDER400", captureId: "DEMOCAPTURE400", amountCents: 4812, fault: "pending" },
  { orderId: "DEMOORDER500", captureId: "DEMOCAPTURE500", amountCents: 6147, fault: "mismatch" },
  { orderId: "DEMOORDER600", captureId: "DEMOCAPTURE600", amountCents: 5218, fault: "failed" },
  { orderId: "DEMOORDER700", captureId: "DEMOCAPTURE700", amountCents: 3176, fault: "lost-hidden" },
] as const;

interface SimulatedRefund {
  id: string;
  capture_id: string;
  amount_cents: number;
  invoice_id: string;
  status: "COMPLETED" | "PENDING" | "FAILED";
}

const money = (cents: number) => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });

/** A persistent fake PayPal. The application uses the real adapter and never bypasses readback. */
export function simulatedSandbox(store: MerchantStore): SandboxTransport {
  store.db.exec(`CREATE TABLE IF NOT EXISTS simulated_provider_refunds (
    id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    invoice_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL
  )`);
  const list = (id: string) => store.db.prepare("SELECT * FROM simulated_provider_refunds WHERE capture_id=?")
    .all(id) as unknown as SimulatedRefund[];

  return async (url, init) => {
    const target = new URL(url);
    if (target.origin !== sandboxOrigin) throw new Error("Unexpected simulation target");
    const parts = target.pathname.split("/");
    if (target.pathname === "/v1/oauth2/token") {
      return Response.json({ access_token: "simulated-token", token_type: "Bearer", expires_in: 300 });
    }
    if (parts[3] === "orders") {
      const item = demoCaptures.find(({ orderId }) => orderId === parts[4]);
      if (!item) return Response.json({}, { status: 404 });
      return Response.json({
        id: item.orderId,
        purchase_units: [{
          payee: { merchant_id: demoMerchant },
          payments: {
            captures: [{ id: item.captureId }],
            refunds: item.fault === "lost-hidden" ? [] : list(item.captureId).map(({ id }) => ({ id })),
          },
        }],
      });
    }
    if (parts[3] === "refunds") {
      const entry = store.db.prepare("SELECT * FROM simulated_provider_refunds WHERE id=?")
        .get(parts[4] ?? "") as unknown as SimulatedRefund | undefined;
      if (!entry) return Response.json({}, { status: 404 });
      const item = demoCaptures.find(({ captureId }) => captureId === entry.capture_id);
      return Response.json({
        id: entry.id, amount: money(entry.amount_cents + (item?.fault === "mismatch" ? 1 : 0)),
        status: entry.status, invoice_id: entry.invoice_id,
        links: [{ rel: "up", href: sandboxOrigin + "/v2/payments/captures/" + entry.capture_id, method: "GET" }],
      });
    }
    const item = demoCaptures.find(({ captureId }) => captureId === parts[4]);
    if (!item) return Response.json({}, { status: 404 });
    if (init.method === "GET") {
      const total = list(item.captureId).filter(({ status }) => status === "COMPLETED")
        .reduce((sum, refund) => sum + refund.amount_cents, 0);
      return Response.json({
        id: item.captureId, amount: money(item.amountCents),
        status: total === 0 ? "COMPLETED" : total < item.amountCents ? "PARTIALLY_REFUNDED" : "REFUNDED",
        supplementary_data: { related_ids: { order_id: item.orderId } },
      });
    }
    const body = JSON.parse(String(init.body)) as { amount: { value: string }; invoice_id: string };
    const amount = parseUsd(body.amount.value);
    if (amount === null || amount < 1) return Response.json({}, { status: 422 });
    const previous = store.db.prepare("SELECT id FROM simulated_provider_refunds WHERE invoice_id=?").get(body.invoice_id);
    if (previous) return Response.json({ id: previous.id });
    const id = "DEMOREF" + randomUUID().replaceAll("-", "");
    const inserted = store.atomic(() => {
      const total = list(item.captureId).filter(({ status }) => status !== "FAILED")
        .reduce((sum, item) => sum + item.amount_cents, 0);
      if (total + amount > item.amountCents) return false;
      const status = item.fault === "pending" ? "PENDING" : item.fault === "failed" ? "FAILED" : "COMPLETED";
      store.db.prepare("INSERT INTO simulated_provider_refunds VALUES (?, ?, ?, ?, ?)")
        .run(id, item.captureId, amount, body.invoice_id, status);
      return true;
    });
    if (!inserted) return Response.json({}, { status: 422 });
    if (item.fault === "lost" || item.fault === "lost-hidden") throw new Error("Simulated response lost after provider acceptance");
    return Response.json({ id }, { status: 201 });
  };
}
