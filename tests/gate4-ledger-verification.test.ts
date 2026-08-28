import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { RefundExecutionBinding } from "../src/domain/change/contracts";
import { createInitialState, reduceChangeGate, type ChangeGateState, type DomainAction } from "../src/domain/engine";
import {
  createSyntheticRefundLedger,
  matchesAuthorizedRefundEffect,
  type RefundEffect,
  type RefundLedgerSnapshot,
  type RefundTransaction,
  type SyntheticRefundReader,
  type SyntheticRefundWriter,
} from "../src/application/synthetic-refund-ledger";
import { verifyAuthorizedRefund } from "../src/application/refund-verifier";

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  if (!result.ok) throw new Error(`Unexpected denial: ${result.error.action}`);
  return result.state;
}

function authorized(approvalId = "ledger-test-approval") {
  const proposal = {
    proposalId: "refund-order-4821", target: "order:4821", action: "SYNTHETIC_PARTIAL_REFUND",
    parameters: { currency: "USD", amountCents: 2500 },
    preconditions: ["order:4821 refunded amount is 0 cents"],
  } as const;
  let state = apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal });
  state = apply(state, { type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT", proposalId: proposal.proposalId });
  if (state.change?.status !== "AWAITING_HUMAN_APPROVAL") throw new Error("Expected review.");
  const identity = {
    proposalId: proposal.proposalId, proposalDigest: state.change.proposal.proposalDigest,
    reviewInstanceId: state.change.reviewInstanceId, approvalId,
  };
  state = apply(state, { type: "HUMAN_APPROVE", ...identity });
  state = apply(state, {
    type: "BEGIN_REFUND_EXECUTION", expectedProposalId: identity.proposalId,
    expectedProposalDigest: identity.proposalDigest, expectedReviewInstanceId: identity.reviewInstanceId,
    expectedApprovalId: identity.approvalId,
  });
  if (state.change?.status !== "EXECUTING" || state.change.executionKind !== "REFUND") throw new Error("Expected refund execution.");
  return { state, binding: state.change.refundExecution };
}

function transaction(binding: RefundExecutionBinding): RefundTransaction {
  return { executionId: binding.executionId, ...binding.effect };
}

// Test-only faulty executor output, kept in private fixture storage. No production tamper API.
function fixtureReader(rows: readonly RefundTransaction[]): SyntheticRefundReader {
  const storage = new Map(rows.map((row) => [row.executionId, Object.freeze({ ...row })]));
  return Object.freeze({
    readRefundState: vi.fn((orderId: "4821"): RefundLedgerSnapshot => {
      const transactions = Object.freeze([...storage.values()].map((row) => Object.freeze({ ...row })));
      return Object.freeze({
        orderId, currency: "USD", transactions, transactionCount: transactions.length,
        refundedAmountCents: transactions.reduce((sum, row) => sum + row.amountCents, 0),
      });
    }),
  });
}

describe("Gate 4 Unit 2A synthetic ledger and independent verification", () => {
  it("starts empty and exposes separate narrow writer and read-only interfaces", () => {
    const { writer, reader } = createSyntheticRefundLedger();
    expect(reader.readRefundState("4821")).toEqual({
      orderId: "4821", currency: "USD", refundedAmountCents: 0, transactionCount: 0, transactions: [],
    });
    expect(Object.keys(writer)).toEqual(["applyAuthorizedRefund"]);
    expect(Object.keys(reader)).toEqual(["readRefundState"]);
    expectTypeOf<Parameters<SyntheticRefundWriter["applyAuthorizedRefund"]>>().toEqualTypeOf<[RefundExecutionBinding]>();
    expectTypeOf<Parameters<SyntheticRefundReader["readRefundState"]>>().toEqualTypeOf<["4821"]>();
    expectTypeOf<Parameters<typeof verifyAuthorizedRefund>>().toEqualTypeOf<[RefundExecutionBinding, SyntheticRefundReader]>();
    expect(writer.applyAuthorizedRefund).toHaveLength(1);
    expect(verifyAuthorizedRefund).toHaveLength(2);
  });

  it("applies the trusted $25 binding and independently verifies one exact immutable transaction", () => {
    const { binding, state } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    expect(writer.applyAuthorizedRefund(binding)).toEqual({ status: "APPLIED" });
    const snapshot = reader.readRefundState("4821");
    expect(snapshot).toEqual({
      orderId: "4821", currency: "USD", refundedAmountCents: 2500, transactionCount: 1,
      transactions: [transaction(binding)],
    });
    const observedReader = { readRefundState: vi.fn(reader.readRefundState) };
    const evidence = verifyAuthorizedRefund(binding, observedReader);
    expect(observedReader.readRefundState).toHaveBeenCalledExactlyOnceWith("4821");
    expect(evidence).toEqual({ executionId: binding.executionId, expected: binding.effect, observed: snapshot, result: "VERIFIED" });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.expected)).toBe(true);
    expect(Object.isFrozen(evidence.observed)).toBe(true);
    expect(Object.isFrozen(evidence.observed?.transactions)).toBe(true);
    expect(Object.isFrozen(evidence.observed?.transactions[0])).toBe(true);
    const verifying = apply(state, { type: "REFUND_EXECUTION_SUCCEEDED", executionId: binding.executionId });
    expect(verifying.change?.status).toBe("VERIFYING");
    expect(reduceChangeGate(verifying, { type: "VERIFICATION_SUCCEEDED" }).ok).toBe(false);
    expectTypeOf<Extract<DomainAction, { type: "REFUND_VERIFICATION_SUCCEEDED" | "REFUND_VERIFICATION_FAILED" }>>().toEqualTypeOf<never>();
  });

  it("deduplicates exact execution replay without increasing the total", () => {
    const { binding } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    expect(writer.applyAuthorizedRefund(binding)).toEqual({ status: "APPLIED" });
    const before = reader.readRefundState("4821");
    expect(writer.applyAuthorizedRefund(binding)).toEqual({ status: "ALREADY_APPLIED" });
    expect(writer.applyAuthorizedRefund({ ...binding, effect: { ...binding.effect } })).toEqual({ status: "ALREADY_APPLIED" });
    expect(reader.readRefundState("4821")).toEqual(before);
  });

  it("rejects conflicting execution content without overwriting the original transaction", () => {
    const { binding } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    writer.applyAuthorizedRefund(binding);
    const before = reader.readRefundState("4821");
    expect(writer.applyAuthorizedRefund({ ...binding, effect: { ...binding.effect, amountCents: 2000 } })).toEqual({
      status: "REJECTED", reason: "EXECUTION_CONFLICT",
    });
    expect(reader.readRefundState("4821")).toEqual(before);
  });

  it("requires the zero-refunded precondition for a different execution ID", () => {
    const { writer, reader } = createSyntheticRefundLedger();
    writer.applyAuthorizedRefund(authorized().binding);
    const before = reader.readRefundState("4821");
    expect(writer.applyAuthorizedRefund(authorized("another-approval").binding)).toEqual({ status: "REJECTED", reason: "PRECONDITION_FAILED" });
    expect(reader.readRefundState("4821")).toEqual(before);
  });

  it.each([
    { amountCents: 7500 }, { amountCents: 3001 }, { amountCents: 12901 },
    { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: NaN },
    { amountCents: Infinity }, { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { orderId: "9999" }, { currency: "EUR" }, { operation: "OTHER" },
  ])("rejects invalid runtime business content and keeps empty storage: %j", (replacement) => {
    const { binding } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    const forged = { ...binding, effect: { ...binding.effect, ...replacement } } as RefundExecutionBinding;
    expect(writer.applyAuthorizedRefund(forged)).toEqual({ status: "REJECTED", reason: "INVALID_BINDING" });
    expect(reader.readRefundState("4821")).toMatchObject({ refundedAmountCents: 0, transactionCount: 0, transactions: [] });
  });

  it.each([
    { executionId: undefined }, { executionId: "" }, { executionId: "other" },
    { executionId: '["refund-execution-v2","human-review:1","ledger-test-approval"]' },
    { executionId: '["refund-execution-v1", "human-review:1", "ledger-test-approval"]' },
    { reviewInstanceId: "different-review" }, { approvalId: "different-approval" },
    { reviewInstanceId: "" }, { approvalId: "" },
  ])("rejects missing or inconsistent opaque execution identity: %j", (replacement) => {
    const { binding } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    expect(writer.applyAuthorizedRefund({ ...binding, ...replacement } as RefundExecutionBinding)).toEqual({ status: "REJECTED", reason: "INVALID_BINDING" });
    expect(reader.readRefundState("4821").transactionCount).toBe(0);
  });

  it.each([
    { amountCents: 2000 }, { amountCents: 7500 }, { orderId: "9999" },
    { currency: "EUR" }, { operation: "OTHER" },
  ])("rejects exact-authority substitution regardless of policy compliance: %j", (replacement) => {
    const { binding } = authorized();
    expect(matchesAuthorizedRefundEffect(binding, { ...binding.effect, ...replacement } as RefundEffect)).toBe(false);
    expect(matchesAuthorizedRefundEffect(binding, { ...binding.effect })).toBe(true);
  });

  it("returns MISMATCH for an empty ledger regardless of an executor success claim", () => {
    const { binding, state } = authorized();
    const verifying = apply(state, { type: "REFUND_EXECUTION_SUCCEEDED", executionId: binding.executionId });
    const { reader } = createSyntheticRefundLedger();
    expect(verifying.change?.status).toBe("VERIFYING");
    expect(verifyAuthorizedRefund(binding, reader)).toMatchObject({ result: "MISMATCH", observed: { refundedAmountCents: 0, transactionCount: 0 } });
  });

  it("reads the private $20 faulty fixture and returns MISMATCH against the $25 authorization", () => {
    const { binding } = authorized();
    const reader = fixtureReader([{ ...transaction(binding), amountCents: 2000 }]);
    expect(verifyAuthorizedRefund(binding, reader)).toMatchObject({
      result: "MISMATCH", expected: { amountCents: 2500 }, observed: { refundedAmountCents: 2000, transactionCount: 1 },
    });
    expect(reader.readRefundState).toHaveBeenCalledExactlyOnceWith("4821");
  });

  it.each([
    { executionId: "wrong" }, { operation: "OTHER" }, { orderId: "9999" }, { currency: "EUR" },
  ])("rejects a wrong ledger transaction field: %j", (replacement) => {
    const { binding } = authorized();
    const reader = fixtureReader([{ ...transaction(binding), ...replacement } as RefundTransaction]);
    expect(verifyAuthorizedRefund(binding, reader).result).toBe("MISMATCH");
  });

  it("rejects two transactions totaling $25", () => {
    const { binding } = authorized();
    const reader = fixtureReader([
      { ...transaction(binding), amountCents: 1250 },
      { ...transaction(binding), executionId: "other", amountCents: 1250 },
    ]);
    expect(verifyAuthorizedRefund(binding, reader)).toMatchObject({ result: "MISMATCH", observed: { refundedAmountCents: 2500, transactionCount: 2 } });
  });

  it.each([
    { orderId: "9999" }, { currency: "EUR" }, { refundedAmountCents: 2000 },
    { transactionCount: 2 }, { transactions: [] },
  ])("rejects inconsistent snapshot metadata/content: %j", (replacement) => {
    const { binding } = authorized();
    const source = fixtureReader([transaction(binding)]);
    const reader: SyntheticRefundReader = {
      readRefundState: (orderId) => ({ ...source.readRefundState(orderId), ...replacement }) as RefundLedgerSnapshot,
    };
    expect(verifyAuthorizedRefund(binding, reader).result).toBe("MISMATCH");
  });

  it("fails closed on a reader exception", () => {
    const { binding } = authorized();
    const reader: SyntheticRefundReader = { readRefundState: () => { throw new Error("Read failed"); } };
    expect(verifyAuthorizedRefund(binding, reader)).toEqual({
      executionId: binding.executionId, expected: binding.effect, observed: null, result: "MISMATCH", reason: "READ_FAILED",
    });
  });

  it("returns detached frozen snapshots without exposing private storage", () => {
    const { binding } = authorized();
    const { writer, reader } = createSyntheticRefundLedger();
    const empty = reader.readRefundState("4821");
    writer.applyAuthorizedRefund(binding);
    const first = reader.readRefundState("4821");
    const second = reader.readRefundState("4821");
    expect(first).not.toBe(second);
    expect(first.transactions).not.toBe(second.transactions);
    expect(first.transactions[0]).not.toBe(second.transactions[0]);
    expect(Reflect.set(first, "refundedAmountCents", 0)).toBe(false);
    expect(Reflect.set(first.transactions, "0", null)).toBe(false);
    expect(Reflect.set(first.transactions[0]!, "amountCents", 0)).toBe(false);
    expect(reader.readRefundState("4821")).toEqual(second);
    expect(empty.transactionCount).toBe(0);
    expect(createSyntheticRefundLedger().reader.readRefundState("4821")).toEqual(empty);
  });

  it("detaches evidence from a mutable reader snapshot", () => {
    const { binding } = authorized();
    const rows = [transaction(binding)];
    const snapshot = { orderId: "4821" as const, currency: "USD" as const, refundedAmountCents: 2500, transactionCount: 1, transactions: rows };
    const evidence = verifyAuthorizedRefund(binding, { readRefundState: () => snapshot });
    Reflect.set(rows[0]!, "amountCents", 2000);
    rows.length = 0;
    snapshot.refundedAmountCents = 0;
    expect(evidence).toMatchObject({ result: "VERIFIED", observed: { refundedAmountCents: 2500, transactions: [{ amountCents: 2500 }] } });
    expect(evidence.expected).not.toBe(binding.effect);
  });
});
