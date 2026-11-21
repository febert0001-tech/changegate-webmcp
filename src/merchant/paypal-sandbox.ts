import { z } from "zod";
import {
  cents, MerchantError, RefundNotSubmitted, parseUsd, providerReference,
  type CaptureSnapshot, type MerchantProvider, type RefundObservation,
} from "./contracts";

export const sandboxOrigin = "https://api-m.sandbox.paypal.com";
export type SandboxTransport = (url: string, init: RequestInit) => Promise<Response>;
const maxResponseBytes = 262_144;
const amount = z.object({ currency_code: z.string(), value: z.string() });
const link = z.object({ rel: z.string(), href: z.string(), method: z.string().optional() });
const referenceObject = z.object({ id: providerReference });
const capture = z.object({
  id: providerReference, amount, status: z.string(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: providerReference }) }).optional(),
});
const order = z.object({
  id: providerReference,
  purchase_units: z.array(z.object({
    payee: z.object({ merchant_id: providerReference }).optional(),
    payments: z.object({
      captures: z.array(referenceObject).optional(),
      refunds: z.array(referenceObject).optional(),
    }).optional(),
  })).min(1).max(10),
});
const refund = z.object({
  id: providerReference, amount, status: z.enum(["COMPLETED", "PENDING", "FAILED", "CANCELLED"]),
  invoice_id: z.string().max(127).optional(), links: z.array(link).max(30),
});
const routes: Readonly<Record<string, RegExp>> = {
  GET: /^\/v2\/(checkout\/orders|payments\/(captures|refunds))\/[A-Za-z0-9]{5,64}$/,
  POST: /^(\/v1\/oauth2\/token|\/v2\/payments\/captures\/[A-Za-z0-9]{5,64}\/refund)$/,
};

function usd(value: string): number {
  const parsed = parseUsd(value);
  if (!cents.safeParse(parsed).success || parsed === null) throw new MerchantError("INVALID_PROVIDER_AMOUNT", 502);
  return parsed;
}

function captureFromLinks(links: z.infer<typeof link>[]): string {
  const up = links.filter(({ rel }) => rel === "up");
  const entry = up[0];
  if (up.length !== 1 || !entry || (entry.method && entry.method !== "GET")) {
    throw new MerchantError("INVALID_REFUND_CAPTURE_LINK", 502);
  }
  const url = new URL(entry.href);
  const match = /^\/v2\/payments\/captures\/([A-Za-z0-9]{5,64})$/.exec(url.pathname);
  if (![sandboxOrigin, "https://api.sandbox.paypal.com"].includes(url.origin) ||
      url.username || url.password || url.search || url.hash || !match?.[1]) {
    throw new MerchantError("INVALID_REFUND_CAPTURE_LINK", 502);
  }
  return match[1];
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(new MerchantError("PAYPAL_READ_DEADLINE", 502));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new MerchantError("PAYPAL_READ_DEADLINE", 502));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Sandbox-only adapter adapted from the prior PayPal build. No redirect, POST retry, or raw response retention. */
export class PayPalMerchantSandbox implements MerchantProvider {
  private token: { value: string; expiry: number } | undefined;

  constructor(
    private readonly options: {
      merchantId: string; clientId: string; clientSecret: string; maxRefundCents: number; lookupTimeoutMs?: number;
    },
    private readonly transport: SandboxTransport = fetch,
  ) {}

  private async json(method: "GET" | "POST", path: string, init: RequestInit, deadline?: AbortSignal): Promise<unknown> {
    if (!routes[method]?.test(path)) throw new MerchantError("SANDBOX_ROUTE_DENIED", 500);
    const timeout = AbortSignal.timeout(10_000);
    const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await withinDeadline(this.transport(sandboxOrigin + path, {
      ...init, method, redirect: "error", signal, cache: "no-store",
    }), signal);
    // Keep upstream bodies, headers and payer data out of operator errors.
    if (!response.ok) throw new MerchantError("PAYPAL_HTTP_" + response.status, 502);
    if (!response.headers.get("content-type")?.includes("application/json") ||
        Number(response.headers.get("content-length") ?? 0) > maxResponseBytes || !response.body) {
      throw new MerchantError("INVALID_PROVIDER_RESPONSE", 502);
    }
    const reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await withinDeadline(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        throw new MerchantError("PROVIDER_RESPONSE_TOO_LARGE", 502);
      }
      pieces.push(part.value);
    }
    return JSON.parse(Buffer.concat(pieces).toString("utf8")) as unknown;
  }

  private async bearer(deadline?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiry > Date.now()) return this.token.value;
    const credentials = Buffer.from(this.options.clientId + ":" + this.options.clientSecret).toString("base64");
    const raw = await this.json("POST", "/v1/oauth2/token", {
      headers: { Authorization: "Basic " + credentials, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }, deadline);
    const token = z.object({
      access_token: z.string().min(1).max(8192), token_type: z.literal("Bearer"), expires_in: z.number().int().positive(),
    }).parse(raw);
    this.token = { value: token.access_token, expiry: Date.now() + Math.min(240, Math.max(0, token.expires_in - 30)) * 1000 };
    return token.access_token;
  }

  private async get(path: string, deadline?: AbortSignal): Promise<unknown> {
    return this.json("GET", path, {
      headers: { Authorization: "Bearer " + await this.bearer(deadline), Accept: "application/json" },
    }, deadline);
  }

  private async readCapture(id: string, deadline: AbortSignal) {
    const value = capture.parse(await this.get("/v2/payments/captures/" + providerReference.parse(id), deadline));
    if (value.id !== id) throw new MerchantError("CAPTURE_IDENTITY_MISMATCH", 502);
    return value;
  }

  private async readOrder(id: string, deadline: AbortSignal) {
    const value = order.parse(await this.get("/v2/checkout/orders/" + providerReference.parse(id), deadline));
    if (value.id !== id) throw new MerchantError("ORDER_IDENTITY_MISMATCH", 502);
    return value;
  }

  async assertCaptureOwnership(captureId: string, orderId: string) {
    const deadline = AbortSignal.timeout(this.options.lookupTimeoutMs ?? 12_000);
    const [payment, parent] = await Promise.all([this.readCapture(captureId, deadline), this.readOrder(orderId, deadline)]);
    const reportedOrder = payment.supplementary_data?.related_ids.order_id;
    const matching = parent.purchase_units.filter((unit) => unit.payments?.captures?.some(({ id }) => id === captureId));
    if ((reportedOrder && reportedOrder !== orderId) || matching.length !== 1 ||
        matching[0]?.payee?.merchant_id !== this.options.merchantId || payment.amount.currency_code !== "USD") {
      throw new MerchantError("MERCHANT_CAPTURE_NOT_FOUND", 404);
    }
  }

  async find(kind: "order" | "capture", reference: string): Promise<CaptureSnapshot[]> {
    const deadline = AbortSignal.timeout(this.options.lookupTimeoutMs ?? 12_000);
    const selected = kind === "capture" ? await this.readCapture(reference, deadline) : null;
    const orderId = selected ? selected.supplementary_data?.related_ids.order_id : reference;
    if (!orderId) throw new MerchantError("CAPTURE_ORDER_LINK_UNAVAILABLE");
    const value = await this.readOrder(orderId, deadline);
    const owned = value.purchase_units.filter(({ payee }) => payee?.merchant_id === this.options.merchantId);
    const result: CaptureSnapshot[] = [];
    const seenCaptures = new Set<string>();
    for (const unit of owned) {
      const ids = (unit.payments?.captures ?? []).map(({ id }) => id);
      const desired = selected ? ids.filter((id) => id === selected.id) : ids;
      if (!desired.length) continue;
      if (desired.length > 25) throw new MerchantError("TOO_MANY_CAPTURES");
      const requested = [];
      for (const id of desired) {
        if (seenCaptures.has(id)) throw new MerchantError("AMBIGUOUS_CAPTURE", 502);
        seenCaptures.add(id);
        requested.push(selected ?? await this.readCapture(id, deadline));
      }
      const refundIds = [...new Set((unit.payments?.refunds ?? []).map(({ id }) => id))];
      const observations: RefundObservation[] = [];
      let complete = refundIds.length <= 100;
      const checkedIds = refundIds.slice(0, 100);
      for (let offset = 0; offset < checkedIds.length && !deadline.aborted; offset += 4) {
        const batch = await Promise.allSettled(checkedIds.slice(offset, offset + 4)
          .map((id) => this.readRefund(id, deadline)));
        for (const outcome of batch) {
          if (outcome.status === "fulfilled" && ids.includes(outcome.value.captureId)) observations.push(outcome.value);
          else complete = false;
        }
      }
      for (const item of requested) {
        const id = item.id;
        const parent = item.supplementary_data?.related_ids.order_id;
        if (parent && parent !== orderId) throw new MerchantError("CAPTURE_ORDER_MISMATCH", 502);
        if (item.amount.currency_code !== "USD") throw new MerchantError("USD_CAPTURE_REQUIRED");
        const amountCents = usd(item.amount.value);
        const refunds = observations.filter(({ captureId }) => captureId === id);
        const completed = refunds.filter(({ status }) => status === "COMPLETED")
          .reduce((sum, evidence) => sum + evidence.amountCents, 0);
        const historyMatchesStatus = (item.status === "COMPLETED" && completed === 0) ||
          (item.status === "PARTIALLY_REFUNDED" && completed > 0 && completed < amountCents) ||
          (item.status === "REFUNDED" && completed === amountCents);
        result.push({
          orderId, captureId: id, merchantId: this.options.merchantId, amountCents, currency: item.amount.currency_code,
          status: item.status, refunds, historyComplete: complete && !deadline.aborted && historyMatchesStatus &&
            refunds.every(({ currency }) => currency === item.amount.currency_code),
        });
      }
    }
    if (!result.length) throw new MerchantError("MERCHANT_CAPTURE_NOT_FOUND", 404);
    return result;
  }

  async submit(captureId: string, amountCents: number, requestId: string): Promise<string> {
    if (!cents.safeParse(amountCents).success || amountCents > this.options.maxRefundCents) {
      throw new MerchantError("REFUND_POLICY_LIMIT");
    }
    const key = z.uuid().parse(requestId);
    let authorization: string;
    try {
      authorization = "Bearer " + await this.bearer();
    } catch {
      throw new RefundNotSubmitted();
    }
    const raw = await this.json("POST", "/v2/payments/captures/" + providerReference.parse(captureId) + "/refund", {
      headers: {
        Authorization: authorization, "Content-Type": "application/json",
        "PayPal-Request-Id": key, Prefer: "return=representation",
      },
      body: JSON.stringify({
        amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" },
        invoice_id: "changegate-" + key,
      }),
    });
    return referenceObject.parse(raw).id;
  }

  async readRefund(id: string, deadline?: AbortSignal): Promise<RefundObservation> {
    const value = refund.parse(await this.get("/v2/payments/refunds/" + providerReference.parse(id), deadline));
    if (value.id !== id) throw new MerchantError("REFUND_IDENTITY_MISMATCH", 502);
    return {
      refundId: id, captureId: captureFromLinks(value.links), amountCents: usd(value.amount.value),
      currency: value.amount.currency_code, status: value.status,
      invoiceId: value.invoice_id ?? null, observedAt: new Date().toISOString(),
    };
  }
}
