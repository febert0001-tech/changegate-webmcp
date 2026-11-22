import { z } from "zod";
import { TeamError } from "./error";
import { MerchantError, providerReference, type RefundObservation } from "./paypal-contracts";
import { PayPalMerchantSandbox, type SandboxTransport } from "./paypal-sandbox";
import type { ElectronicAttemptTerms, ElectronicSaleEvidence, ProviderRefundEvidence, TestSale } from "./refund-requests";

const settings = z.object({ teamMerchantId: z.string().min(1), merchantId: providerReference,
  clientId: z.string().regex(/^\S+$/), clientSecret: z.string().regex(/^\S+$/), allowRefunds: z.boolean() });
type Settings = z.infer<typeof settings>;

export function configuredPayPalSandbox(env: Record<string, string | undefined> = process.env) {
  if (env.CHANGEGATE_PAYPAL_MODE !== "sandbox") return undefined;
  const result = settings.safeParse({
    teamMerchantId: env.CHANGEGATE_PAYPAL_TEAM_MERCHANT_ID,
    merchantId: env.CHANGEGATE_PAYPAL_SANDBOX_MERCHANT_ID,
    clientId: env.CHANGEGATE_PAYPAL_SANDBOX_CLIENT_ID,
    clientSecret: env.CHANGEGATE_PAYPAL_SANDBOX_CLIENT_SECRET,
    allowRefunds: env.CHANGEGATE_PAYPAL_SANDBOX_ALLOW_REFUNDS === "1",
  });
  return result.success ? new PayPalProvider(result.data) : undefined;
}

export class PayPalProvider {
  private readonly adapter: PayPalMerchantSandbox;
  constructor(private readonly config: Settings, transport?: SandboxTransport) {
    this.adapter = new PayPalMerchantSandbox({ ...config, maxRefundCents: 99_999_999 }, transport);
  }

  supports(teamMerchantId: string, sale?: TestSale) {
    return this.config.teamMerchantId === teamMerchantId && (!sale || sale.paypal?.merchantId === this.config.merchantId);
  }

  async lookup(reference: string): Promise<ElectronicSaleEvidence> {
    const capture = await this.capture(reference);
    const counted = capture.refunds.filter(item => item.status === "COMPLETED" || item.status === "PENDING");
    const priorCents = counted.reduce((sum, refund) => sum + refund.amountCents, 0);
    if (priorCents > capture.amountCents) throw new TeamError("PAYPAL_HISTORY_UNAVAILABLE", 409);
    return { sale: { reference, originalCents: capture.amountCents, priorCents, tender: "Electronic",
      location: "Unavailable", register: "Unavailable", shift: "Unavailable",
      paypal: { merchantId: capture.merchantId, orderId: capture.orderId } },
      countedRefunds: counted.map(item => this.project(item)) };
  }

  private async capture(reference: string) {
    if (!providerReference.safeParse(reference).success) throw new TeamError("PAYPAL_CAPTURE_UNAVAILABLE", 422);
    try {
      const [result] = await this.adapter.find("capture", reference);
      if (!result?.historyComplete) throw new TeamError("PAYPAL_HISTORY_UNAVAILABLE", 409);
      return result;
    } catch (error) {
      if (error instanceof TeamError) throw error;
      if (error instanceof MerchantError && (error.status === 404 || error.code === "PAYPAL_HTTP_404" ||
          error.code === "USD_CAPTURE_REQUIRED")) throw new TeamError("PAYPAL_CAPTURE_UNAVAILABLE", 422);
      throw new TeamError("PAYPAL_PROVIDER_UNAVAILABLE", 503);
    }
  }

  assertExecutionEnabled() {
    if (!this.config.allowRefunds) throw new TeamError("PAYPAL_REFUNDS_DISABLED", 409);
  }

  submit(terms: ElectronicAttemptTerms) {
    this.assertExecutionEnabled();
    return this.adapter.submit(terms.paymentId, terms.amountCents, terms.key);
  }

  async readback(terms: ElectronicAttemptTerms, refundId?: string): Promise<RefundObservation | undefined> {
    if (!terms.orderId) return undefined;
    if (refundId) {
      await this.adapter.assertCaptureOwnership(terms.paymentId, terms.orderId);
      return this.adapter.readRefund(refundId);
    }
    const capture = await this.capture(terms.paymentId);
    if (capture.orderId !== terms.orderId) return undefined;
    const invoices = capture.refunds.filter(refund => refund.invoiceId === "changegate-" + terms.key);
    // Capture history independently reads each refund by ID before projecting it.
    return invoices.length === 1 ? invoices[0] : undefined;
  }

  project(refund: RefundObservation): ProviderRefundEvidence {
    return { id: refund.refundId, paymentId: refund.captureId, amountCents: refund.amountCents,
      currency: refund.currency, status: refund.status };
  }
}
