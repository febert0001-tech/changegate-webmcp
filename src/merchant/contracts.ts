import { z } from "zod";

export const providerReference = z.string().regex(/^[A-Za-z0-9]{5,64}$/);
const caseId = z.uuid();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const cents = z.number().int().positive().max(99_999_999);

export const merchantCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("session") }),
  z.strictObject({ action: z.literal("queue") }),
  z.strictObject({ action: z.literal("find"), kind: z.enum(["order", "capture"]), reference: providerReference }),
  z.strictObject({ action: z.literal("case"), id: caseId }),
  z.strictObject({ action: z.literal("propose"), captureId: providerReference, amountCents: cents.nullable() }),
  z.strictObject({ action: z.literal("review"), id: caseId, version }),
  z.strictObject({ action: z.literal("decide"), id: caseId, version, decision: z.enum(["approve", "reject"]) }),
  z.strictObject({ action: z.literal("execute"), id: caseId, version }),
  z.strictObject({ action: z.literal("reconcile"), id: caseId, refundId: providerReference.optional() }),
]);
export type MerchantCommand = z.infer<typeof merchantCommand>;
export type ProviderRefundStatus = "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED";
export type CaseStatus =
  | "PROPOSED" | "REVIEW" | "APPROVED" | "REJECTED" | "SUBMITTED"
  | "PENDING" | "COMPLETED" | "FAILED" | "UNCERTAIN";

export interface RefundObservation {
  refundId: string;
  captureId: string;
  amountCents: number;
  currency: string;
  status: ProviderRefundStatus;
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

export interface MerchantProvider {
  find(kind: "order" | "capture", reference: string): Promise<CaptureSnapshot[]>;
  submit(captureId: string, amountCents: number, requestId: string): Promise<string>;
  readRefund(id: string): Promise<RefundObservation>;
}

export interface MerchantCase {
  id: string;
  orderId: string;
  captureId: string;
  amountCents: number;
  currency: "USD";
  version: number;
  status: CaseStatus;
  decision: "APPROVED" | "REJECTED" | null;
  reviewer: string | null;
  decisionAt: string | null;
  submittedAt: string | null;
  refundId: string | null;
  observation: Omit<RefundObservation, "invoiceId"> | null;
  issue: string | null;
}

export interface MerchantEvent {
  sequence: number;
  actor: string;
  type: string;
  lifecycle: CaseStatus;
  occurredAt: string;
}

export interface MerchantCaseDetail {
  case: MerchantCase;
  audit: { totalEvents: number; truncated: boolean; events: MerchantEvent[] };
}

export type MerchantCapture = Omit<CaptureSnapshot, "merchantId" | "refunds"> & {
  refunds: Omit<RefundObservation, "invoiceId">[];
  outstanding: { id: string; amountCents: number; status: CaseStatus; refundId: string | null }[];
  remainingCents: number | null;
};

export const merchantEnvironments = ["PayPal Sandbox", "Simulated PayPal Sandbox"] as const;
export type MerchantEnvironment = typeof merchantEnvironments[number];

export class MerchantError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}

export function parseUsd(value: string): number | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
