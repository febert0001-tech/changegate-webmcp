import type { ShiftSale } from "./demo-shift";
import { cents, checks, providerVerification, requestDecision, requestReceipt, submitted, type RefundRequest } from "./refund-requests";

type Activity = { reference: string; location: string; register: string; at: string; amountCents: number };
export type ShiftRefund = Activity & { id: string; cashier: string; reason: string; status: string; nextAction: string;
  awaitingApproval: boolean; awaitingSubmission: boolean; confirmedPayoutCents: number | null };
export type ShiftOverview = { runId: string | null; seed: string; locations: string[]; sales: ShiftSale[]; refunds: ShiftRefund[] };

export function summarizeShift(records: Omit<ShiftOverview, "refunds">, requests: RefundRequest[]): ShiftOverview {
  const refunds = requests.map(request => {
    const decision = requestDecision(request);
    const check = checks(request);
    const verification = providerVerification(request);
    const awaitingApproval = !decision && (check.route === "manager" || check.route === "exception");
    const awaitingSubmission = decision?.decision === "Approved" && requestReceipt(request).execution.status === "Not submitted";
    const confirmedPayoutCents = verification?.result === "Verified" && verification.refund?.status === "COMPLETED"
      ? verification.refund.amountCents : null;
    return {
      id: request.id, reference: request.terms.reference, amountCents: cents(request.terms.amount),
      location: request.sale?.location ?? "Unavailable", register: request.sale?.register ?? "Unavailable",
      cashier: submitted(request).actor, at: submitted(request).occurredAt, reason: check.explanation,
      awaitingApproval, awaitingSubmission, confirmedPayoutCents,
      status: awaitingApproval ? "Awaiting approval" : awaitingSubmission ? "Approved awaiting submission" :
        confirmedPayoutCents !== null ? "Confirmed payout" : decision?.decision ?? "Request recorded",
      nextAction: awaitingApproval ? "Supervisor reviews the request" : awaitingSubmission
        ? "Submission blocked while payment connectors are disabled" : "Open receipt",
    };
  });
  return { ...records, refunds: refunds.reverse() };
}

export const shiftMetrics = [
  ["sales", "Recorded sales"], ["discounts", "Discounts"], ["refunds", "Refund requests"],
  ["approval", "Awaiting approval"], ["submission", "Approved awaiting submission"], ["payouts", "Confirmed payouts"],
] as const;
export type ShiftMetric = (typeof shiftMetrics)[number][0];

export function shiftGroups(overview: ShiftOverview, location: string) {
  const inLocation = (row: { location: string }) => !location || row.location === location;
  const sales = overview.sales.filter(inLocation);
  const refunds = overview.refunds.filter(inLocation);
  return {
    sales: sales.map(sale => ({ ...sale, amountCents: sale.netCents })),
    discounts: sales.filter(sale => sale.discountCents > 0).map(sale => ({ ...sale, amountCents: sale.discountCents })),
    refunds,
    approval: refunds.filter(refund => refund.awaitingApproval),
    submission: refunds.filter(refund => refund.awaitingSubmission),
    payouts: refunds.flatMap(refund => refund.confirmedPayoutCents === null ? [] :
      [{ ...refund, amountCents: refund.confirmedPayoutCents }]),
  };
}
