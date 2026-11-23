import { z } from "zod";

export const providerReference = z.string().regex(/^[A-Za-z0-9]{5,64}$/);
export const cents = z.number().int().positive().max(99_999_999);

export interface RefundObservation {
  refundId: string;
  captureId: string;
  amountCents: number;
  currency: string;
  status: "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED";
  invoiceId: string | null;
  observedAt: string;
}

export interface CaptureSnapshot {
  orderId: string;
  captureId: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  status: string;
  refunds: RefundObservation[];
  historyComplete: boolean;
}

export class MerchantError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}

export class RefundNotSubmitted extends Error {}
export class RefundSubmissionRejected extends Error {}

export function parseUsd(value: string): number | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
