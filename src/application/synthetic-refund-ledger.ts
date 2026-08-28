import type { RefundExecutionBinding } from "../domain/change/contracts";

export type RefundEffect = RefundExecutionBinding["effect"];

export interface RefundTransaction extends RefundEffect {
  readonly executionId: string;
}

export interface RefundLedgerSnapshot {
  readonly orderId: "4821";
  readonly currency: "USD";
  readonly refundedAmountCents: number;
  readonly transactionCount: number;
  readonly transactions: readonly RefundTransaction[];
}

export type RefundWriteResult =
  | Readonly<{ status: "APPLIED" | "ALREADY_APPLIED" }>
  | Readonly<{ status: "REJECTED"; reason: "INVALID_BINDING" | "EXECUTION_CONFLICT" | "PRECONDITION_FAILED" }>;

export interface SyntheticRefundWriter {
  readonly applyAuthorizedRefund: (binding: RefundExecutionBinding) => RefundWriteResult;
}

export interface SyntheticRefundReader {
  readonly readRefundState: (orderId: "4821") => RefundLedgerSnapshot;
}

/** Structural defense only: the caller must supply authority from the trusted domain. */
export function isValidRefundExecutionBinding(binding: RefundExecutionBinding): boolean {
  const effect = binding?.effect;
  return effect !== undefined && effect !== null &&
    effect.operation === "SYNTHETIC_PARTIAL_REFUND" &&
    effect.orderId === "4821" && effect.currency === "USD" &&
    Number.isSafeInteger(effect.amountCents) && effect.amountCents > 0 &&
    effect.amountCents <= 3000 && effect.amountCents <= 12900 &&
    typeof binding.reviewInstanceId === "string" && binding.reviewInstanceId.length > 0 &&
    typeof binding.approvalId === "string" && binding.approvalId.length > 0 &&
    typeof binding.executionId === "string" &&
    // Compare the accepted opaque convention; never parse the execution ID.
    binding.executionId === JSON.stringify(["refund-execution-v1", binding.reviewInstanceId, binding.approvalId]);
}

/** Policy compliance alone does not prove exact authorization. This helper never writes. */
export function matchesAuthorizedRefundEffect(binding: RefundExecutionBinding, attempted: RefundEffect): boolean {
  return attempted.operation === binding.effect.operation &&
    attempted.orderId === binding.effect.orderId &&
    attempted.currency === binding.effect.currency &&
    attempted.amountCents === binding.effect.amountCents;
}

export function createSyntheticRefundLedger(): Readonly<{
  writer: SyntheticRefundWriter;
  reader: SyntheticRefundReader;
}> {
  const transactions = new Map<string, RefundTransaction>();

  const writer: SyntheticRefundWriter = Object.freeze({
    applyAuthorizedRefund(binding: RefundExecutionBinding): RefundWriteResult {
      if (!isValidRefundExecutionBinding(binding)) {
        return Object.freeze({ status: "REJECTED", reason: "INVALID_BINDING" });
      }
      const existing = transactions.get(binding.executionId);
      if (existing !== undefined) {
        return matchesAuthorizedRefundEffect(binding, existing)
          ? Object.freeze({ status: "ALREADY_APPLIED" })
          : Object.freeze({ status: "REJECTED", reason: "EXECUTION_CONFLICT" });
      }
      // This scenario requires no prior refund. A new execution ID is not a retry.
      if (transactions.size !== 0) {
        return Object.freeze({ status: "REJECTED", reason: "PRECONDITION_FAILED" });
      }
      const transaction: RefundTransaction = Object.freeze({
        executionId: binding.executionId,
        operation: binding.effect.operation,
        orderId: binding.effect.orderId,
        currency: binding.effect.currency,
        amountCents: binding.effect.amountCents,
      });
      // Validation, deduplication, and insertion are synchronous and indivisible.
      transactions.set(transaction.executionId, transaction);
      return Object.freeze({ status: "APPLIED" });
    },
  });

  const reader: SyntheticRefundReader = Object.freeze({
    readRefundState(orderId: "4821"): RefundLedgerSnapshot {
      if (orderId !== "4821") throw new TypeError("Unsupported synthetic refund order.");
      const detached = Object.freeze([...transactions.values()].map((transaction) => Object.freeze({ ...transaction })));
      return Object.freeze({
        orderId,
        currency: "USD",
        refundedAmountCents: detached.reduce((total, transaction) => total + transaction.amountCents, 0),
        transactionCount: detached.length,
        transactions: detached,
      });
    },
  });

  return Object.freeze({ writer, reader });
}
