import type { ChangeLifecycleState } from "../domain/change/contracts";
import { hasRefundProposalShape } from "../domain/refund";
import type {
  AuditTrailProjection,
  ChangeProposalProjection,
  RefundVerificationProjection,
} from "./changegate-operations";

export const SYNTHETIC_ENVIRONMENT_LABEL = "Synthetic environment";

const decisionByLifecycle: Partial<Record<ChangeLifecycleState, string>> = {
  PROPOSED: "NOT_REQUESTED",
  AWAITING_HUMAN_APPROVAL: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  EXECUTING: "APPROVED",
  VERIFYING: "APPROVED",
  SUCCEEDED: "APPROVED",
  FAILED: "APPROVED",
};

export function createDecisionReceipt(
  proposal: ChangeProposalProjection,
  audit: AuditTrailProjection,
  verification: RefundVerificationProjection | null,
  exportedAt: Date,
) {
  if (!hasRefundProposalShape(proposal)) return null;

  const { lifecycle } = proposal;
  // VERIFYING and verification evidence both imply that the writer reported success.
  // Only an independent match confirms the refund amount.
  const executionStatus = verification !== null || lifecycle === "VERIFYING" ? "EXECUTED"
    : lifecycle === "FAILED" ? "FAILED"
    : lifecycle === "EXECUTING" ? "IN_PROGRESS"
    : lifecycle === "APPROVED" ? "PENDING_EXECUTE"
    : lifecycle === "SUCCEEDED" ? null : "NOT_EXECUTED";

  return {
    schemaVersion: 1,
    environment: SYNTHETIC_ENVIRONMENT_LABEL,
    exportedAt: exportedAt.toISOString(),
    proposal: {
      id: proposal.proposalId,
      orderId: proposal.target.slice("order:".length),
      requestedAmountCents: proposal.parameters.amountCents,
      currency: proposal.parameters.currency,
    },
    lifecycle,
    decision: { status: decisionByLifecycle[lifecycle] ?? null },
    execution: {
      status: executionStatus,
      refundOutcome: verification?.result === "VERIFIED" ? "CONFIRMED"
        : executionStatus === "NOT_EXECUTED" || executionStatus === "PENDING_EXECUTE" ? "NOT_EXECUTED"
        : "UNKNOWN",
      confirmedRefundedAmountCents: verification?.result === "VERIFIED"
        ? verification.observed?.refundedAmountCents ?? null
        : null,
    },
    verification: {
      status: verification?.result === "VERIFIED" ? "VERIFIED"
        : verification !== null ? "FAILED"
        : lifecycle === "VERIFYING" ? "IN_PROGRESS"
        : lifecycle === "SUCCEEDED" ? null : "NOT_RUN",
      reason: verification?.reason ?? null,
      expected: verification?.expected ?? null,
      observed: verification?.observed ?? null,
    },
    audit: {
      totalEvents: audit.totalEvents,
      truncated: audit.truncated,
      events: audit.events.map(({ sequence, actor, type, lifecycle }) => ({
        sequence, actor, type, lifecycle, occurredAt: null,
      })),
    },
  };
}
