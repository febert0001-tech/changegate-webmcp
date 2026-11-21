import { z } from "zod";
import { SYNTHETIC_ENVIRONMENT_LABEL } from "./decision-receipt";

const receiptSummarySchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.literal(SYNTHETIC_ENVIRONMENT_LABEL),
  decision: z.object({
    status: z.enum(["NOT_REQUESTED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"]).nullable(),
  }),
  execution: z.object({
    status: z.enum(["NOT_EXECUTED", "PENDING_EXECUTE", "IN_PROGRESS", "EXECUTED", "FAILED"]).nullable(),
  }),
  verification: z.object({
    status: z.enum(["NOT_RUN", "IN_PROGRESS", "VERIFIED", "FAILED"]).nullable(),
  }),
});

export type DecisionReceiptSummary = z.infer<typeof receiptSummarySchema>;

type DecisionStatus = NonNullable<DecisionReceiptSummary["decision"]["status"]>;
type ExecutionStatus = NonNullable<DecisionReceiptSummary["execution"]["status"]>;
type VerificationStatus = NonNullable<DecisionReceiptSummary["verification"]["status"]>;

const compatibleStatuses: Readonly<Record<ExecutionStatus, {
  decision: readonly DecisionStatus[];
  verification: readonly VerificationStatus[];
}>> = {
  NOT_EXECUTED: { decision: ["NOT_REQUESTED", "PENDING", "REJECTED", "EXPIRED"], verification: ["NOT_RUN"] },
  PENDING_EXECUTE: { decision: ["APPROVED"], verification: ["NOT_RUN"] },
  IN_PROGRESS: { decision: ["APPROVED"], verification: ["NOT_RUN"] },
  EXECUTED: { decision: ["APPROVED"], verification: ["IN_PROGRESS", "VERIFIED", "FAILED"] },
  FAILED: { decision: ["APPROVED"], verification: ["NOT_RUN"] },
};

type ReceiptConsistency =
  | { status: "consistent" }
  | { status: "inconsistent"; explanation: string }
  | { status: "unavailable" };

export function checkDecisionReceiptConsistency(receipt: DecisionReceiptSummary): ReceiptConsistency {
  const { status: execution } = receipt.execution;
  const { status: decision } = receipt.decision;
  const { status: verification } = receipt.verification;
  if (execution === null) return { status: "unavailable" };

  const compatible = compatibleStatuses[execution];
  if (verification !== null && !compatible.verification.includes(verification)) {
    return {
      status: "inconsistent",
      explanation: execution === "PENDING_EXECUTE"
        ? "Execution is still pending. Independent verification requires a completed execution."
        : "The execution and independent verification statuses conflict.",
    };
  }
  if (decision !== null && !compatible.decision.includes(decision)) {
    return { status: "inconsistent", explanation: "The human decision and execution statuses conflict." };
  }
  return { status: decision === null || verification === null ? "unavailable" : "consistent" };
}

export function readDecisionReceipt(text: string): DecisionReceiptSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  // Keep only display fields from the untrusted file.
  const result = receiptSummarySchema.safeParse(value);
  return result.success ? result.data : null;
}
