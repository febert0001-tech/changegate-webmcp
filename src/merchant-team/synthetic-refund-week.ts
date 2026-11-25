import { ruleVersion } from "./refund-monitor-rules";
import { previewRefundThreshold, syntheticRefundWeek } from "./refund-threshold-preview";
import { cents, routeVerifiedRefund, testSale, thresholdReason, type RefundRequest } from "./refund-requests";
import { cashTimeZone } from "./weekly-cash-review";

const thresholdCents = 5000;

// The four in-scope requests from the closed-week regression. Keep all
// evidence in the example so replay never writes to the merchant database.
const requests: RefundRequest[] = [
  exampleRequest("morning-first", "TEST-MONITOR-1", "25.00", 25000, 2500, "2026-11-16T05:00:00Z"),
  exampleRequest("morning-second", "TEST-MONITOR-1", "25.00", 22500, 5000, "2026-11-16T05:01:00Z"),
  exampleRequest("older-rules", "TEST-MONITOR-3", "3.00", 25000, 300, "2026-11-16T05:02:00Z", "older-rules"),
  exampleRequest("evening", "TEST-SALE-CASH", "50.00", 6500, 5000, "2026-11-23T04:59:59Z", ruleVersion,
    ["The amount is unusually large for the test baseline (score 4.32)."]),
];

function exampleRequest(id: string, reference: string, amount: string, balanceCents: number, cumulativeCents: number,
  occurredAt: string, evidenceVersion = ruleVersion, otherReasons: string[] = []): RefundRequest {
  const sale = testSale(reference);
  if (!sale) throw Error("Missing synthetic week sale: " + reference);
  const reasons = cumulativeCents >= thresholdCents
    ? [...otherReasons, thresholdReason(cumulativeCents, thresholdCents)] : otherReasons;
  const actor = "Synthetic cashier";
  return {
    id, sale, terms: { reference, amount, currency: "USD", reason: "Synthetic weekly preview" },
    events: [
      { kind: "Request submitted", actor, occurredAt },
      { kind: "Checks recorded", actor, occurredAt, check: {
        ...routeVerifiedRefund(sale, cents(amount), balanceCents, reasons),
        balanceCents, cumulativeCents, thresholdCents,
        monitoring: { ruleVersion: evidenceVersion, z: null, watch: false, cashierWatchCount: 0,
          registerWatchCount: 0, related: [], reasons },
      } },
    ],
  };
}

export function previewSyntheticRefundWeek(proposedCents: number) {
  return {
    ...previewRefundThreshold(requests, thresholdCents, proposedCents),
    period: { start: syntheticRefundWeek.start, end: syntheticRefundWeek.end, timeZone: cashTimeZone },
  };
}
