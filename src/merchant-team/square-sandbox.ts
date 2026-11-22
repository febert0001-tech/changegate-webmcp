import { z } from "zod";
import { TeamError } from "./error";
import type { SquareRefundEvidence, TestSale } from "./refund-requests";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const money = z.object({ amount: z.number().int().nonnegative().safe(), currency: z.string().length(3) });
const payment = z.object({ id: identifier, location_id: identifier, status: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  source_type: z.string(), total_money: money, refunded_money: money.optional(),
  refund_ids: z.array(identifier).max(20).optional() });
const refund = z.object({ id: identifier, payment_id: identifier, location_id: identifier,
  amount_money: money, status: z.enum(["PENDING", "COMPLETED", "FAILED", "REJECTED"]) });
const config = z.object({ accessToken: z.string().regex(/^\S+$/), teamMerchantId: z.string().min(1),
  merchantId: identifier, locationId: identifier });
export type SquareConfig = z.infer<typeof config>;
export type SquareSaleEvidence = { sale: TestSale; countedRefundIds: string[] };
export type SquareAttemptTerms = {
  key: string; paymentId: string; locationId: string; merchantId: string; amountCents: number; currency: "USD";
};

export function configuredSquareSandbox(env = process.env) {
  const result = config.safeParse({
    accessToken: env.CHANGEGATE_SQUARE_SANDBOX_ACCESS_TOKEN,
    teamMerchantId: env.CHANGEGATE_SQUARE_TEAM_MERCHANT_ID,
    merchantId: env.CHANGEGATE_SQUARE_SANDBOX_MERCHANT_ID,
    locationId: env.CHANGEGATE_SQUARE_SANDBOX_LOCATION_ID,
  });
  return result.success ? new SquareSandbox(result.data) : undefined;
}

export class SquareSandbox {
  constructor(private readonly settings: SquareConfig, private readonly transport = fetch) {}

  supports(teamMerchantId: string, sale?: TestSale) {
    return this.settings.teamMerchantId === teamMerchantId && (!sale ||
      (sale.square?.merchantId === this.settings.merchantId && sale.square.locationId === this.settings.locationId));
  }

  private async call<T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
    try {
      const response = await this.transport("https://connect.squareupsandbox.com/v2" + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer " + this.settings.accessToken, "Square-Version": "2026-11-18",
          ...(body && { "Content-Type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404 && path.startsWith("/payments/")) throw new TeamError("SQUARE_SALE_UNAVAILABLE", 422);
      if (!response.ok) throw new Error("Square request failed");
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof TeamError) throw error;
      throw new TeamError("SQUARE_PROVIDER_UNAVAILABLE", 503);
    }
  }

  private async verifyMerchant() {
    const identity = await this.call("/merchants/me", z.object({ merchant: z.object({ id: identifier }) }));
    if (identity.merchant.id !== this.settings.merchantId) throw new TeamError("SQUARE_SCOPE_MISMATCH", 503);
  }

  async lookup(reference: string): Promise<SquareSaleEvidence> {
    if (!identifier.safeParse(reference).success) throw new TeamError("SQUARE_SALE_UNAVAILABLE", 422);
    await this.verifyMerchant();
    const { payment: original } = await this.call("/payments/" + reference, z.object({ payment }));
    if (original.id !== reference || original.location_id !== this.settings.locationId ||
        original.status !== "COMPLETED" || original.source_type !== "CARD" ||
        original.total_money.currency !== "USD" || original.total_money.amount === 0) {
      throw new TeamError("SQUARE_SALE_UNAVAILABLE", 422);
    }
    const ids = [...new Set(original.refund_ids ?? [])];
    const oldest = new Date();
    oldest.setUTCFullYear(oldest.getUTCFullYear() - 1);
    if (Date.parse(original.created_at) < oldest.getTime() || ids.length >= 20) {
      throw new TeamError("SQUARE_SALE_INELIGIBLE", 422);
    }
    const prior = await Promise.all(ids.map(id => this.readRefund(id)));
    if (prior.some((item, index) => item.id !== ids[index] || item.paymentId !== original.id ||
        item.locationId !== original.location_id || item.currency !== "USD")) {
      throw new TeamError("SQUARE_PROVIDER_UNAVAILABLE", 503);
    }
    const completed = prior.filter(item => item.status === "COMPLETED").reduce((sum, item) => sum + item.amountCents, 0);
    const active = prior.filter(item => item.status === "COMPLETED" || item.status === "PENDING");
    const priorCents = active.reduce((sum, item) => sum + item.amountCents, 0);
    if ((original.refunded_money && original.refunded_money.currency !== "USD") ||
        completed !== (original.refunded_money?.amount ?? 0) || priorCents > original.total_money.amount) {
      throw new TeamError("SQUARE_PROVIDER_UNAVAILABLE", 503);
    }
    return { sale: { reference, location: original.location_id, register: "Unavailable", shift: "Unavailable",
      originalCents: original.total_money.amount, priorCents, tender: "Electronic",
      square: { merchantId: this.settings.merchantId, locationId: this.settings.locationId } },
      countedRefundIds: active.map(item => item.id) };
  }

  async submit(terms: SquareAttemptTerms) {
    await this.verifyMerchant();
    const { refund: result } = await this.call("/refunds", z.object({ refund }), {
      idempotency_key: terms.key, payment_id: terms.paymentId,
      amount_money: { amount: terms.amountCents, currency: terms.currency },
    });
    return this.projectRefund(result);
  }

  async verify(id: string) {
    await this.verifyMerchant();
    return this.readRefund(id);
  }

  private async readRefund(id: string) {
    const { refund: result } = await this.call("/refunds/" + id, z.object({ refund }));
    return this.projectRefund(result);
  }

  private projectRefund(result: z.infer<typeof refund>): SquareRefundEvidence {
    return { id: result.id, paymentId: result.payment_id, locationId: result.location_id,
      amountCents: result.amount_money.amount, currency: result.amount_money.currency, status: result.status };
  }
}
