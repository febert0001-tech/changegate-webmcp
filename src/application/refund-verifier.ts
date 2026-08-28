import type { RefundExecutionBinding } from "../domain/change/contracts";
import {
  isValidRefundExecutionBinding,
  matchesAuthorizedRefundEffect,
  type RefundEffect,
  type RefundLedgerSnapshot,
  type SyntheticRefundReader,
} from "./synthetic-refund-ledger";

export type RefundVerificationEvidence = Readonly<{
  executionId: string;
  expected: RefundEffect;
}> & (
  | Readonly<{ result: "VERIFIED"; observed: RefundLedgerSnapshot }>
  | Readonly<{ result: "MISMATCH"; observed: RefundLedgerSnapshot | null; reason: "LEDGER_MISMATCH" | "READ_FAILED" }>
);

/** Reads independently; executor results and caller-supplied observations are not inputs. */
export function verifyAuthorizedRefund(
  binding: RefundExecutionBinding,
  reader: SyntheticRefundReader,
): RefundVerificationEvidence {
  const expected: RefundEffect = Object.freeze({
    operation: binding.effect.operation,
    orderId: binding.effect.orderId,
    currency: binding.effect.currency,
    amountCents: binding.effect.amountCents,
  });
  const trustedBinding = Object.freeze({ ...binding, effect: expected });
  const identity = { executionId: trustedBinding.executionId, expected };
  try {
    const snapshot = reader.readRefundState("4821");
    // Detach evidence even if another reader implementation returns mutable data.
    const observed: RefundLedgerSnapshot = Object.freeze({
      orderId: snapshot.orderId,
      currency: snapshot.currency,
      refundedAmountCents: snapshot.refundedAmountCents,
      transactionCount: snapshot.transactionCount,
      transactions: Object.freeze(snapshot.transactions.map((transaction) => Object.freeze({
        executionId: transaction.executionId,
        operation: transaction.operation,
        orderId: transaction.orderId,
        currency: transaction.currency,
        amountCents: transaction.amountCents,
      }))),
    });
    const transaction = observed.transactions[0];
    const verified = isValidRefundExecutionBinding(trustedBinding) &&
      observed.orderId === "4821" && observed.currency === "USD" &&
      observed.refundedAmountCents === expected.amountCents &&
      observed.transactionCount === 1 && observed.transactions.length === 1 &&
      transaction !== undefined && transaction.executionId === trustedBinding.executionId &&
      matchesAuthorizedRefundEffect(trustedBinding, transaction);

    return verified
      ? Object.freeze({ ...identity, observed, result: "VERIFIED" })
      : Object.freeze({ ...identity, observed, result: "MISMATCH", reason: "LEDGER_MISMATCH" });
  } catch {
    return Object.freeze({ ...identity, observed: null, result: "MISMATCH", reason: "READ_FAILED" });
  }
}
