import type { RefundExecutionBinding } from "./change/contracts";

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

export interface SyntheticRefundReader {
  readonly readRefundState: (orderId: "4821") => RefundLedgerSnapshot;
}

export type RefundVerificationEvidence = Readonly<{
  /** Exact reducer-owned object, not a reconstructed identity or authority claim. */
  authorization: RefundExecutionBinding;
  executionId: string;
  expected: RefundEffect;
}> & (
  | Readonly<{ result: "VERIFIED"; observed: RefundLedgerSnapshot }>
  | Readonly<{ result: "MISMATCH"; observed: RefundLedgerSnapshot | null; reason: "LEDGER_MISMATCH" | "READ_FAILED" }>
);

export interface RefundVerifier {
  readonly verify: (binding: RefundExecutionBinding) => RefundVerificationEvidence;
}

const trustedEvidence = new WeakSet<RefundVerificationEvidence>();

/** Provenance only. The reducer must also check the exact current authorization. */
export function isTrustedRefundVerificationEvidence(value: unknown): value is RefundVerificationEvidence {
  return typeof value === "object" && value !== null && trustedEvidence.has(value as RefundVerificationEvidence);
}

function register(evidence: RefundVerificationEvidence): RefundVerificationEvidence {
  Object.freeze(evidence);
  trustedEvidence.add(evidence);
  return evidence;
}

// Preserve Unit 2A's structural binding defense without importing application code.
// This is validation, never authority; authority requires the reducer's exact object.
function isValidBinding(binding: RefundExecutionBinding): boolean {
  const effect = binding.effect;
  return effect.operation === "SYNTHETIC_PARTIAL_REFUND" &&
    effect.orderId === "4821" && effect.currency === "USD" &&
    Number.isSafeInteger(effect.amountCents) && effect.amountCents > 0 &&
    effect.amountCents <= 3000 && effect.amountCents <= 12900 &&
    typeof binding.reviewInstanceId === "string" && binding.reviewInstanceId.length > 0 &&
    typeof binding.approvalId === "string" && binding.approvalId.length > 0 &&
    typeof binding.executionId === "string" &&
    binding.executionId === JSON.stringify(["refund-execution-v1", binding.reviewInstanceId, binding.approvalId]);
}

/**
 * INTERNAL trusted-composition primitive. Reader selection is trusted, not an
 * agent/UI capability. Internal imports are not a boundary against malicious JS.
 * Ordinary calls accept only the reducer-owned binding, never a reader/receipt.
 */
export function createRefundVerifier(reader: SyntheticRefundReader): RefundVerifier {
  const readRefundState = reader.readRefundState.bind(reader);
  return Object.freeze({
    verify(binding: RefundExecutionBinding): RefundVerificationEvidence {
      // Retain identity without leaving a mutable authorization inside evidence.
      if (!Object.isFrozen(binding) || !Object.isFrozen(binding.effect)) {
        throw new TypeError("Refund verification requires an immutable execution binding.");
      }
      const expected: RefundEffect = Object.freeze({
        operation: binding.effect.operation,
        orderId: binding.effect.orderId,
        currency: binding.effect.currency,
        amountCents: binding.effect.amountCents,
      });
      const identity = { authorization: binding, executionId: binding.executionId, expected };
      try {
        const snapshot = readRefundState("4821");
        // Detach even when a trusted test reader returns mutable observations.
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
        const verified = isValidBinding(binding) &&
          observed.orderId === "4821" && observed.currency === "USD" &&
          observed.refundedAmountCents === expected.amountCents &&
          observed.transactionCount === 1 && observed.transactions.length === 1 &&
          transaction !== undefined && transaction.executionId === binding.executionId &&
          transaction.operation === expected.operation && transaction.orderId === expected.orderId &&
          transaction.currency === expected.currency && transaction.amountCents === expected.amountCents;

        return verified
          ? register({ ...identity, observed, result: "VERIFIED" })
          : register({ ...identity, observed, result: "MISMATCH", reason: "LEDGER_MISMATCH" });
      } catch {
        return register({ ...identity, observed: null, result: "MISMATCH", reason: "READ_FAILED" });
      }
    },
  });
}
