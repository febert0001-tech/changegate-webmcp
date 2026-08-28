import { describe, expect, expectTypeOf, it, vi } from "vitest";

import * as applicationVerifier from "../src/application/refund-verifier";
import { createRefundVerifier, type RefundVerifier } from "../src/application/refund-verifier";
import { createSyntheticRefundLedger } from "../src/application/synthetic-refund-ledger";
import type { ChangeProposalInput, RefundExecutionBinding } from "../src/domain/change/contracts";
import { createInitialState, reduceChangeGate, type ChangeGateState, type DomainAction } from "../src/domain/engine";
import {
  isTrustedRefundVerificationEvidence,
  type RefundLedgerSnapshot,
  type RefundVerificationEvidence,
  type SyntheticRefundReader,
} from "../src/domain/refund-verification";

const refund = {
  proposalId: "refund-order-4821", target: "order:4821", action: "SYNTHETIC_PARTIAL_REFUND",
  parameters: { currency: "USD", amountCents: 2500 },
  preconditions: ["order:4821 refunded amount is 0 cents"],
} as const;

const gateway = {
  proposalId: "gateway", target: "agent-gateway", action: "RESTART_SIMULATED_GATEWAY",
  parameters: { mode: "safe", retryLimit: 1 }, preconditions: ["agent-gateway is DEGRADED"],
} as const;

type Completion = Extract<DomainAction, { type: "REFUND_VERIFICATION_COMPLETED" }>;
function completion(evidence: RefundVerificationEvidence): Completion {
  return { type: "REFUND_VERIFICATION_COMPLETED", evidence };
}

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  if (!result.ok) throw new Error(`Unexpected denial: ${result.error.action}`);
  return result.state;
}

function expectDenied(state: ChangeGateState, action: DomainAction): void {
  const before = structuredClone(state);
  const { audit, change } = state;
  expect(reduceChangeGate(state, action)).toEqual({
    ok: false,
    error: { code: "ILLEGAL_TRANSITION", action: action.type, currentState: state.change?.status ?? "NONE" },
  });
  expect(state).toEqual(before);
  expect(state.audit).toBe(audit);
  expect(state.change).toBe(change);
}

function approved(
  proposal: ChangeProposalInput = refund,
  initial = createInitialState(),
  approvalId = "unit2b-approval",
): ChangeGateState {
  let state = apply(initial, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal });
  state = apply(state, { type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT", proposalId: proposal.proposalId });
  if (state.change?.status !== "AWAITING_HUMAN_APPROVAL") throw new Error("Expected review.");
  return apply(state, {
    type: "HUMAN_APPROVE", proposalId: proposal.proposalId,
    proposalDigest: state.change.proposal.proposalDigest,
    reviewInstanceId: state.change.reviewInstanceId, approvalId,
  });
}

function execution(initial = createInitialState(), approvalId = "unit2b-approval") {
  const approval = approved(refund, initial, approvalId);
  if (approval.change?.status !== "APPROVED") throw new Error("Expected approval.");
  const executing = apply(approval, {
    type: "BEGIN_REFUND_EXECUTION",
    expectedProposalId: approval.change.proposal.proposalId,
    expectedProposalDigest: approval.change.proposal.proposalDigest,
    expectedReviewInstanceId: approval.change.reviewInstanceId,
    expectedApprovalId: approval.change.approval.approvalId,
  });
  if (executing.change?.status !== "EXECUTING" || executing.change.executionKind !== "REFUND") {
    throw new Error("Expected refund execution.");
  }
  const binding = executing.change.refundExecution;
  const ledger = createSyntheticRefundLedger();
  // Trusted test composition captures the actual ledger reader before any write.
  const verifier = createRefundVerifier(ledger.reader);
  const verifying = () => apply(executing, { type: "REFUND_EXECUTION_SUCCEEDED", executionId: binding.executionId });
  return { approval, executing, binding, ledger, verifier, verifying };
}

function written() {
  const context = execution();
  expect(context.ledger.writer.applyAuthorizedRefund(context.binding)).toEqual({ status: "APPLIED" });
  return context;
}

// Trusted TEST composition only; no product fault, reader-selection, or tamper API.
function fixtureReader(binding: RefundExecutionBinding, amountCents = 2000): SyntheticRefundReader {
  const transaction = Object.freeze({ executionId: binding.executionId, ...binding.effect, amountCents });
  return Object.freeze({
    readRefundState: vi.fn((): RefundLedgerSnapshot => ({
      orderId: "4821", currency: "USD", refundedAmountCents: amountCents,
      transactionCount: 1, transactions: [transaction],
    })),
  });
}

describe("Gate 4 Unit 2B trusted composed verifier completion", () => {
  it("captures one reader at composition and exposes only a frozen one-argument verifier", () => {
    const context = execution();
    const originalRead = vi.fn(context.ledger.reader.readRefundState);
    const reader = { readRefundState: originalRead };
    const verifier = createRefundVerifier(reader);
    const invented = fixtureReader(context.binding, 2500);
    reader.readRefundState = vi.fn(invented.readRefundState);
    expectTypeOf<Parameters<RefundVerifier["verify"]>>().toEqualTypeOf<[RefundExecutionBinding]>();
    expectTypeOf<keyof Completion>().toEqualTypeOf<"type" | "evidence">();
    expect(Object.keys(applicationVerifier)).toEqual(["createRefundVerifier"]);
    expect(Object.keys(verifier)).toEqual(["verify"]);
    expect(Object.isFrozen(verifier)).toBe(true);
    expect(verifier.verify).toHaveLength(1);
    // JavaScript extra arguments cannot replace the captured observation source.
    const evidence = Reflect.apply(verifier.verify, null, [context.binding, invented, { result: "VERIFIED" }]);
    expect(evidence).toMatchObject({ result: "MISMATCH", observed: { transactionCount: 0 } });
    expect(originalRead).toHaveBeenCalledExactlyOnceWith("4821");
    expect(reader.readRefundState).not.toHaveBeenCalled();
    expect(invented.readRefundState).not.toHaveBeenCalled();
  });

  it("completes the actual $25 ledger path and retains the exact consumed authority/evidence chain", () => {
    const { executing, binding, ledger, verifier, verifying } = execution();
    expect(executing.change).toMatchObject({ approval: { status: "CONSUMED" } });
    expect(ledger.writer.applyAuthorizedRefund(binding)).toEqual({ status: "APPLIED" });
    const state = verifying();
    const evidence = verifier.verify(binding);
    expect(evidence.result).toBe("VERIFIED");
    expect(evidence.authorization).toBe(binding);
    expect(isTrustedRefundVerificationEvidence(evidence)).toBe(true);
    const terminal = apply(state, completion(evidence));
    expect(terminal.change).toEqual({ ...state.change, status: "SUCCEEDED", verificationEvidence: evidence });
    if (terminal.change?.status !== "SUCCEEDED" || terminal.change.executionKind !== "REFUND") {
      throw new Error("Expected refund success.");
    }
    expect(terminal.change.proposal).toBe(executing.change?.proposal);
    expect(terminal.change.approval).toBe(executing.change && "approval" in executing.change ? executing.change.approval : null);
    expect(terminal.change.approval.status).toBe("CONSUMED");
    expect(terminal.change.refundExecution).toBe(binding);
    expect(terminal.change.verificationEvidence).toBe(evidence);
    expect(terminal.environment).toBe(state.environment);
    expect(terminal.audit).toHaveLength(state.audit.length + 1);
    expect(terminal.audit.at(-1)).toEqual({
      sequence: state.nextSequence, actor: "SYSTEM", type: "REFUND_VERIFICATION_COMPLETED", lifecycle: "SUCCEEDED",
    });
    expect(ledger.writer.applyAuthorizedRefund(binding)).toEqual({ status: "ALREADY_APPLIED" });
    expect(ledger.reader.readRefundState("4821").transactionCount).toBe(1);
  });

  it.each(["LEDGER_MISMATCH", "READ_FAILED"] as const)(
    "terminalizes authentic %s as FAILED/VERIFICATION with the full execution/evidence chain",
    (reason) => {
      const { binding, verifying } = execution();
      const reader = reason === "LEDGER_MISMATCH" ? fixtureReader(binding) : {
        readRefundState: () => { throw new Error("Read unavailable"); },
      };
      const evidence = createRefundVerifier(reader).verify(binding);
      expect(evidence).toMatchObject({ result: "MISMATCH", reason, expected: { amountCents: 2500 } });
      expect(evidence.observed).toEqual(reason === "READ_FAILED" ? null : {
        orderId: "4821", currency: "USD", refundedAmountCents: 2000, transactionCount: 1,
        transactions: [{ executionId: binding.executionId, ...binding.effect, amountCents: 2000 }],
      });
      expect(isTrustedRefundVerificationEvidence(evidence)).toBe(true);
      const state = verifying();
      const terminal = apply(state, completion(evidence));
      expect(terminal.change).toEqual({
        ...state.change, status: "FAILED", failureStage: "VERIFICATION", verificationEvidence: evidence,
      });
      if (terminal.change?.status !== "FAILED" || terminal.change.executionKind !== "REFUND" ||
          terminal.change.failureStage !== "VERIFICATION") throw new Error("Expected refund verification failure.");
      expect(terminal.change.refundExecution).toBe(binding);
      expect(terminal.change.verificationEvidence).toBe(evidence);
      expect(terminal.change.approval.status).toBe("CONSUMED");
      expect(terminal.change.proposal).toBe(state.change?.proposal);
      expectDenied(terminal, { type: "REQUEST_ROLLBACK_APPROVAL", actor: "HUMAN" });
    },
  );

  it.each(["handmade", "shallow clone", "deep clone", "nested clone retaining authorization", "edited clone"] as const)(
    "denies %s of genuine VERIFIED evidence", (kind) => {
      const { binding, verifier, verifying } = written();
      const genuine = verifier.verify(binding);
      const forged: RefundVerificationEvidence = kind === "handmade" ? {
        authorization: binding, executionId: binding.executionId,
        expected: { ...binding.effect }, result: "VERIFIED",
        observed: {
          orderId: "4821", currency: "USD", refundedAmountCents: 2500, transactionCount: 1,
          transactions: [{ executionId: binding.executionId, ...binding.effect }],
        },
      } : kind === "deep clone" ? structuredClone(genuine)
        : kind === "nested clone retaining authorization" ? {
            ...genuine, expected: { ...genuine.expected },
            observed: structuredClone(genuine.observed),
          } as RefundVerificationEvidence
        : kind === "edited clone" ? { ...genuine, expected: { ...genuine.expected, amountCents: 2000 } }
        : { ...genuine };
      if (kind !== "edited clone") expect(forged).toEqual(genuine);
      Object.freeze(forged);
      expect(isTrustedRefundVerificationEvidence(forged)).toBe(false);
      expectDenied(verifying(), completion(forged));
      expect(apply(verifying(), completion(genuine)).change?.status).toBe("SUCCEEDED");
    },
  );

  it.each([undefined, null, true, 1, "VERIFIED", {}, Symbol("evidence")])(
    "denies arbitrary runtime evidence %s", (value) => {
      expect(isTrustedRefundVerificationEvidence(value)).toBe(false);
      expectDenied(execution().verifying(), completion(value as RefundVerificationEvidence));
    },
  );

  it("denies genuine VERIFIED evidence from a byte-identical cloned binding", () => {
    const { binding, verifier, verifying } = written();
    const clone = Object.freeze({ ...binding, effect: Object.freeze({ ...binding.effect }) });
    const evidence = verifier.verify(clone);
    expect(evidence.result).toBe("VERIFIED");
    expect(isTrustedRefundVerificationEvidence(evidence)).toBe(true);
    expect(evidence.authorization).toEqual(binding);
    expect(evidence.authorization).toBe(clone);
    expect(evidence.authorization).not.toBe(binding);
    expectDenied(verifying(), completion(evidence));
  });

  it.each([
    { executionId: "another-execution" }, { approvalId: "another-approval" },
    { reviewInstanceId: "another-review" }, { proposalId: "another-proposal" },
    { proposalDigest: "another-digest" },
    { effect: { ...refund.parameters, operation: refund.action, orderId: "4821", amountCents: 2000 } },
    { effect: { operation: "OTHER", orderId: "4821", currency: "USD", amountCents: 2500 } },
    { effect: { operation: refund.action, orderId: "9999", currency: "USD", amountCents: 2500 } },
    { effect: { operation: refund.action, orderId: "4821", currency: "EUR", amountCents: 2500 } },
  ])("denies authentic evidence with a different authorization field: %j", (replacement) => {
    const { binding, verifier, verifying } = written();
    const other = Object.freeze({
      ...binding, ...replacement, effect: Object.freeze({ ...(replacement.effect ?? binding.effect) }),
    }) as RefundExecutionBinding;
    const evidence = verifier.verify(other);
    expect(isTrustedRefundVerificationEvidence(evidence)).toBe(true);
    expect(evidence.authorization).toBe(other);
    expectDenied(verifying(), completion(evidence));
  });

  it.each(["unit2b-approval", "next-approval"])(
    "denies genuine old evidence after identical reproposal with approval %s", (approvalId) => {
      const old = written();
      const oldEvidence = old.verifier.verify(old.binding);
      const terminal = apply(old.verifying(), completion(oldEvidence));
      const next = execution(apply(terminal, { type: "RESET_SCENARIO" }), approvalId);
      expect(next.binding.proposalId).toBe(old.binding.proposalId);
      expect(next.binding.proposalDigest).toBe(old.binding.proposalDigest);
      expect(next.binding.reviewInstanceId).not.toBe(old.binding.reviewInstanceId);
      expect(next.binding.executionId).not.toBe(old.binding.executionId);
      expectDenied(next.verifying(), completion(oldEvidence));
      next.ledger.writer.applyAuthorizedRefund(next.binding);
      expect(apply(next.verifying(), completion(next.verifier.verify(next.binding))).change?.status).toBe("SUCCEEDED");
    },
  );

  it("denies genuine evidence from a separate reducer instance even when all lifecycle strings match", () => {
    const old = written();
    const next = execution();
    expect(old.binding).toEqual(next.binding);
    expect(old.binding).not.toBe(next.binding);
    expectDenied(next.verifying(), completion(old.verifier.verify(old.binding)));
  });

  it("denies genuine evidence before VERIFYING and against gateway VERIFYING", () => {
    const { binding, verifier, approval, executing } = written();
    const evidence = verifier.verify(binding);
    expectDenied(createInitialState(), completion(evidence));
    expectDenied(approval, completion(evidence));
    expectDenied(executing, completion(evidence));
    const gatewayVerifying = apply(apply(approved(gateway), { type: "BEGIN_EXECUTION" }), { type: "EXECUTION_SUCCEEDED" });
    expectDenied(gatewayVerifying, completion(evidence));
  });

  it.each(["VERIFIED", "MISMATCH"] as const)("denies replay and evidence replacement after %s terminalization", (result) => {
    const { binding, verifier, ledger, verifying } = execution();
    if (result === "VERIFIED") ledger.writer.applyAuthorizedRefund(binding);
    const evidence = verifier.verify(binding);
    expect(evidence.result).toBe(result);
    const terminal = apply(verifying(), completion(evidence));
    expectDenied(terminal, completion(evidence));
    expectDenied(terminal, completion(verifier.verify(binding)));
    const opposite = createRefundVerifier(fixtureReader(binding, result === "VERIFIED" ? 2000 : 2500)).verify(binding);
    expectDenied(terminal, completion(opposite));
    expect(terminal.audit.filter((event) => event.type === "REFUND_VERIFICATION_COMPLETED")).toHaveLength(1);
    expect(terminal.change && "verificationEvidence" in terminal.change ? terminal.change.verificationEvidence : null).toBe(evidence);
  });

  it.each(["executionId", "result", "amountCents", "orderId", "currency", "reader", "observed", "receipt", Symbol("hidden")])(
    "denies extra completion authority field %s", (field) => {
      const { binding, verifier, verifying } = written();
      const action = completion(verifier.verify(binding));
      Object.defineProperty(action, field, { value: "substitution", enumerable: false });
      expectDenied(verifying(), action);
    },
  );

  it("requires own action keys and retains a single captured evidence value", () => {
    const { binding, verifier, verifying } = written();
    const evidence = verifier.verify(binding);
    const inherited = Object.assign(Object.create({ evidence }), { type: "REFUND_VERIFICATION_COMPLETED" }) as Completion;
    expectDenied(verifying(), inherited);
    let reads = 0;
    const action: Completion = { type: "REFUND_VERIFICATION_COMPLETED", get evidence() {
      reads += 1;
      return reads === 1 ? evidence : { ...evidence };
    } };
    const terminal = apply(verifying(), action);
    expect(reads).toBe(1);
    expect(terminal.change && "verificationEvidence" in terminal.change ? terminal.change.verificationEvidence : null).toBe(evidence);
  });

  it("preserves immutable terminal evidence and detached observations", () => {
    const { binding, verifying } = execution();
    const rows = [{ executionId: binding.executionId, ...binding.effect }];
    const snapshot = { orderId: "4821" as const, currency: "USD" as const, refundedAmountCents: 2500, transactionCount: 1, transactions: rows };
    const evidence = createRefundVerifier({ readRefundState: () => snapshot }).verify(binding);
    const terminal = apply(verifying(), completion(evidence));
    snapshot.refundedAmountCents = 0;
    rows[0]!.amountCents = 0;
    rows.length = 0;
    expect(evidence.observed).toMatchObject({ refundedAmountCents: 2500, transactions: [{ amountCents: 2500 }] });
    for (const [object, key, value] of [
      [terminal.change!, "verificationEvidence", {}],
      [evidence, "result", "MISMATCH"], [evidence, "executionId", "other"],
      [evidence, "authorization", {}], [evidence.expected, "amountCents", 0],
      [evidence.authorization, "executionId", "other"], [evidence.authorization.effect, "amountCents", 0],
      [evidence.observed!, "refundedAmountCents", 0], [evidence.observed!.transactions, "0", {}],
      [evidence.observed!.transactions[0]!, "amountCents", 0],
    ] as const) {
      expect(Object.isFrozen(object)).toBe(true);
      expect(Reflect.set(object, key, value)).toBe(false);
    }
  });

  it("rejects mutable authorization objects without reading or retaining them in evidence", () => {
    const { binding } = execution();
    const reader = fixtureReader(binding);
    const verifier = createRefundVerifier(reader);
    expect(() => verifier.verify({ ...binding })).toThrow("immutable execution binding");
    expect(() => verifier.verify(Object.freeze({ ...binding, effect: { ...binding.effect } }))).toThrow("immutable execution binding");
    expect(reader.readRefundState).not.toHaveBeenCalled();
  });

  it.each(["VERIFICATION_SUCCEEDED", "VERIFICATION_FAILED"] as const)(
    "keeps %s gateway-only and preserves its original terminal representation", (type) => {
      expectDenied(execution().verifying(), { type });
      const state = apply(apply(approved(gateway), { type: "BEGIN_EXECUTION" }), { type: "EXECUTION_SUCCEEDED" });
      if (state.change?.status !== "VERIFYING" || state.change.executionKind !== "GATEWAY") throw new Error("Expected gateway.");
      const terminal = apply(state, { type });
      expect(terminal.change).toEqual(type === "VERIFICATION_SUCCEEDED" ? {
        status: "SUCCEEDED", proposal: state.change.proposal, reviewInstanceId: state.change.reviewInstanceId,
        approval: state.change.approval,
      } : {
        status: "FAILED", executionKind: "GATEWAY", proposal: state.change.proposal,
        reviewInstanceId: state.change.reviewInstanceId, failureStage: "VERIFICATION",
        preChangeSnapshot: state.change.preChangeSnapshot,
      });
    },
  );
});
