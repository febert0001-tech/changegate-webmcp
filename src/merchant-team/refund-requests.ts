import type { syntheticRegisterDrift } from "./refund-monitor-rules";
import { z } from "zod";

export const refundTerms = z.strictObject({
  source: z.enum(["test", "square"]).optional(),
  reference: z.string().trim().min(1).max(160).regex(/^[^\p{Cc}]+$/u),
  amount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/).refine(amount => Number(amount) > 0),
  currency: z.literal("USD"),
  reason: z.string().trim().min(1).max(1200),
});
export type RefundTerms = z.infer<typeof refundTerms>;
export type RefundDecision = "Approved" | "Rejected";
export type MerchantRole = "cashier" | "manager" | "owner";
export interface TestSale {
  reference: string;
  location: string;
  register: string;
  shift: string;
  originalCents: number;
  priorCents: number;
  tender: "Cash" | "Electronic";
  square?: { merchantId: string; locationId: string };
}
export type SquareRefundStatus = "PENDING" | "COMPLETED" | "FAILED" | "REJECTED";
export interface SquareRefundEvidence {
  id: string;
  paymentId: string;
  locationId: string;
  amountCents: number;
  currency: string;
  status: SquareRefundStatus;
}
export interface RefundCheck {
  balanceCents: number | null;
  cumulativeCents: number | null;
  thresholdCents: number;
  route: "routine" | "manager" | "exception" | "over-balance";
  explanation: string;
  monitoring?: {
    ruleVersion: string; z: number | null; watch: boolean; cashierWatchCount: number;
    registerWatchCount: number; related: string[]; reasons: string[]; drift?: ReturnType<typeof syntheticRegisterDrift>;
  };
}
export type TransactionEvent =
  | { kind: "Request submitted"; actor: string; occurredAt: string }
  | { kind: "Checks recorded"; actor: string; occurredAt: string; check: RefundCheck }
  | { kind: "Decision recorded"; actor: string; occurredAt: string; decision: RefundDecision }
  | { kind: "Cash payout reported"; actor: string; occurredAt: string }
  | { kind: "Square attempt recorded" | "Square response unavailable"; actor: string; occurredAt: string }
  | { kind: "Square refund response"; actor: string; occurredAt: string; refund: SquareRefundEvidence }
  | { kind: "Square independent lookup"; actor: string; occurredAt: string; refund: SquareRefundEvidence | null;
      result: "Verified" | "Pending" | "Mismatch" | "Unconfirmed" | "Failed" };
export interface RefundRequest {
  id: string;
  terms: RefundTerms;
  sale: TestSale | null;
  events: TransactionEvent[];
}
export const transactionTabs = [
  ["sale", "Sale"], ["checks", "Checks"], ["approval", "Approval"],
  ["execution", "Execution"], ["receipt", "Receipt"],
] as const;
export type TransactionStep = (typeof transactionTabs)[number][0];

export const canReview = (role?: MerchantRole) => role === "manager" || role === "owner";
export function cents(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export const money = (value: number) => usd.format(value / 100);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const sales: TestSale[] = [
  { reference:"TEST-SALE-CASH", location:"Harbor Fuel", register:"Register 1", shift:"Evening", originalCents:6500, priorCents:0, tender:"Cash" },
  { reference:"TEST-SALE-BALANCE", location:"Harbor Fuel", register:"Register 2", shift:"Morning", originalCents:4200, priorCents:1800, tender:"Electronic" },
  { reference:"TEST-SALE-PARTIAL", location:"Harbor Bar", register:"Bar 1", shift:"Evening", originalCents:9000, priorCents:2900, tender:"Cash" },
  { reference:"TEST-SALE-ELECTRONIC", location:"Harbor Bar", register:"Bar 1", shift:"Evening", originalCents:7800, priorCents:0, tender:"Electronic" },
  ...[1,2,3,4,5,6].map(number => ({reference:"TEST-MONITOR-"+number,location:"Harbor Fuel",register:number<=3?"Register 2":"Register "+number,
    shift:"Morning",originalCents:25000,priorCents:0,tender:"Electronic" as const})),
];
export const testSale = (reference: string) => sales.find(sale => sale.reference === reference) ?? null;
export const submitted = (request: RefundRequest) => request.events.find(event => event.kind === "Request submitted")!;
export const checks = (request: RefundRequest) => request.events.findLast(event => event.kind === "Checks recorded")!.check;
export const requestDecision = (request: RefundRequest) => request.events.find(event => event.kind === "Decision recorded");
export const payout = (request: RefundRequest) => request.events.find(event => event.kind === "Cash payout reported");
export const squareResponse = (request: RefundRequest) => request.events.find(event => event.kind === "Square refund response");
export const squareVerification = (request: RefundRequest) => request.events.findLast(event => event.kind === "Square independent lookup");
export const squareAttempt = (request: RefundRequest) => request.events.find(event => event.kind === "Square attempt recorded");
export function requestStatus(request: RefundRequest) {
  const decision = requestDecision(request);
  const route = checks(request).route;
  if (payout(request)) return "Cash payout recorded";
  if (route === "over-balance") return "Blocked · Over refundable balance";
  if (decision?.decision === "Rejected") return "Rejected";
  if (!decision && (route === "manager" || route === "exception")) return "Needs manager decision";
  if (request.sale?.tender === "Cash") return "Ready for cash payout";
  if (request.sale?.square) {
    const verified = squareVerification(request);
    if (verified?.result === "Verified") return "Square Sandbox refund verified";
    if (verified?.result === "Failed") return "Square Sandbox refund failed";
    if (squareResponse(request)) return "Square refund awaiting confirmation";
    if (squareAttempt(request)) return "Square attempt · Outcome unconfirmed";
    return "Ready for Square Sandbox refund";
  }
  return "Blocked · Processor not connected";
}
export function currentStep(request: RefundRequest): TransactionStep {
  const status = requestStatus(request);
  if (status.startsWith("Blocked · Over")) return "checks";
  if (status === "Needs manager decision" || status === "Rejected") return "approval";
  return payout(request) || squareResponse(request) ? "receipt" : "execution";
}
export function requestReceipt(request: RefundRequest) {
  const decision = requestDecision(request);
  const reported = payout(request);
  const attempted = squareAttempt(request);
  const response = squareResponse(request);
  const verification = squareVerification(request);
  return {
    schemaVersion: 1,
    environment: request.terms.source === "square" ? "Square Sandbox · No real money moved" : "Test data · No money moved",
    exportedAt: new Date().toISOString(),
    transactionId: request.id,
    requested: request.terms,
    sale: request.sale,
    checks: checks(request),
    decision: decision ? { status: decision.decision, reviewer: decision.actor, occurredAt: decision.occurredAt } :
      { status: checks(request).route === "routine" ? "Within store policy" : "No decision recorded" },
    execution: { status: response?.refund.status ?? (attempted ? "Outcome unconfirmed" : reported ? "Test cash payout reported" : "Not submitted"),
      authorizedBy: reported || attempted ? decision?.actor ?? "Store policy" : null, reportedBy: reported?.actor ?? null,
      attempt: attempted ? { actor: attempted.actor, occurredAt: attempted.occurredAt } : null, providerResponse: response?.refund ?? null },
    verification: { status: verification?.result ?? "Not run", independentReadback: verification?.refund ?? null },
    events: request.events,
  };
}
