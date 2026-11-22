import type { MerchantCaseDetail, MerchantEnvironment } from "./contracts";

export function merchantReceipt(detail: MerchantCaseDetail, environment: MerchantEnvironment, exportedAt = new Date()) {
  const { case: refundCase, audit } = detail;
  const { status, decision, observation } = refundCase;
  const noProviderRefund = refundCase.issue === "REFUND_NOT_SUBMITTED" || refundCase.issue === "REFUND_SUBMISSION_REJECTED";
  const executionStatus = noProviderRefund ? "FAILED" : status === "APPROVED" ? "PENDING_EXECUTE"
    : !refundCase.submittedAt ? "NOT_EXECUTED"
    : refundCase.refundId || observation ? "EXECUTED" : "IN_PROGRESS";
  const verificationStatus = noProviderRefund ? "NOT_RUN" : status === "COMPLETED" ? "VERIFIED"
    : status === "FAILED" || (status === "UNCERTAIN" && observation) ? "FAILED"
    : refundCase.refundId ? "IN_PROGRESS" : "NOT_RUN";
  return {
    schemaVersion: 1,
    environment,
    exportedAt: exportedAt.toISOString(),
    proposal: {
      id: refundCase.id, orderId: refundCase.orderId, captureId: refundCase.captureId,
      version: refundCase.version, requestedAmountCents: refundCase.amountCents, currency: refundCase.currency,
    },
    lifecycle: status,
    decision: {
      status: decision ?? (status === "REVIEW" ? "PENDING" : "NOT_REQUESTED"),
      reviewer: refundCase.reviewer, occurredAt: refundCase.decisionAt,
    },
    execution: {
      status: executionStatus,
      submittedAt: refundCase.submittedAt,
      providerRefundId: refundCase.refundId,
      refundOutcome: noProviderRefund ? "NOT_EXECUTED" : status === "COMPLETED" ? "CONFIRMED" : status === "FAILED" ? "FAILED"
        : refundCase.submittedAt ? "UNKNOWN" : "NOT_EXECUTED",
    },
    verification: {
      status: verificationStatus,
      source: observation ? (environment === "PayPal Sandbox" ? "INDEPENDENT_PAYPAL_SANDBOX_GET" : "SIMULATED_PROVIDER_GET") : null,
      observed: observation,
      issue: refundCase.issue,
    },
    audit,
  };
}
