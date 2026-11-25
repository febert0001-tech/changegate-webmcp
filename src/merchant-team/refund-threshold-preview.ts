import { ruleVersion } from "./refund-monitor-rules";
import { cents, money, routeVerifiedRefund, thresholdReason, type RefundCheck, type RefundRequest } from "./refund-requests";

export function canPreviewRefundThreshold(user: { username: string; role?: string | undefined }, demo: boolean) {
  return user.role === "owner" || (demo && user.role === "manager" && user.username === "jordan");
}

export function refundPreviewScope(request: RefundRequest) {
  return { location: request.sale?.location ?? "Unavailable", shift: request.sale?.shift ?? "Unavailable" };
}

type Outcome = "Supervisor review" | "Routine" | "Blocked" | "Insufficient evidence";
type Row = { id: string; amountCents: number; current: Outcome; proposed: Outcome; reason: string };
export type ThresholdPreview = { currentCents: number; proposedCents: number; added: number; removed: number; insufficient: number; rows: Row[] };

function outcome(route: RefundCheck["route"]): Outcome {
  if (route === "over-balance") return "Blocked";
  return route === "routine" ? "Routine" : "Supervisor review";
}

export function previewRefundThreshold(requests: RefundRequest[], currentCents: number, proposedCents: number): ThresholdPreview {
  const result: ThresholdPreview = { currentCents, proposedCents, added: 0, removed: 0, insufficient: 0, rows: [] };
  for (const request of requests) {
    const amountCents = cents(request.terms.amount);
    const saved = request.events.find(event => event.kind === "Checks recorded")?.check;
    const sale = request.sale;
    const balance = saved?.balanceCents;
    const cumulative = saved?.cumulativeCents;
    const monitoring = saved?.monitoring;
    if (!sale || !saved || balance == null || cumulative == null || monitoring?.ruleVersion !== ruleVersion ||
        !Number.isSafeInteger(balance) || !Number.isSafeInteger(cumulative) || !Array.isArray(monitoring.reasons)) {
      result.insufficient++;
      result.rows.push({ id: request.id, amountCents, current: "Insufficient evidence", proposed: "Insufficient evidence",
        reason: "The saved request lacks a verified sale, refundable balance, or compatible rule evidence." });
      continue;
    }
    const oldAmountReason = thresholdReason(cumulative, saved.thresholdCents);
    const unchangedReasons = monitoring.reasons.filter(reason => reason !== oldAmountReason);
    const evaluate = (threshold: number) => routeVerifiedRefund(sale, amountCents, balance, cumulative >= threshold
      ? [thresholdReason(cumulative, threshold), ...unchangedReasons] : unchangedReasons);
    const current = outcome(evaluate(currentCents).route);
    const proposedCheck = evaluate(proposedCents);
    const proposed = outcome(proposedCheck.route);
    if (proposed === "Supervisor review" && current !== "Supervisor review") result.added++;
    if (current === "Supervisor review" && proposed !== "Supervisor review") result.removed++;
    const reason = current === "Supervisor review" && proposed === "Routine"
      ? money(cumulative) + " in cumulative refunds is below the proposed " + money(proposedCents) + " threshold. No other saved rule requires a hold."
      : proposed === "Supervisor review" && unchangedReasons.length
        ? [...new Set([proposedCheck.explanation, ...unchangedReasons])].join(" ")
        : proposedCheck.explanation;
    result.rows.push({ id: request.id, amountCents, current, proposed, reason });
  }
  return result;
}
