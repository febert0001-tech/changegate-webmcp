import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createChangeGateOperations,
  createWebMcpOperationsFacade,
  type ChangeGateWebMcpOperations,
  type ChangeProposalProjection,
  type FlagshipChangeInput,
} from "../src/application/changegate-operations";
import type {
  ChangeProposalInput,
  HumanApproval,
  ImmutableChangeProposal,
  ImmutableRefundProposal,
  RefundProposalInput,
} from "../src/domain/change/contracts";
import { computeProposalDigest, createImmutableProposal } from "../src/domain/change/proposal-digest";
import { createInitialState, isApprovalBoundToProposal, reduceChangeGate, type ChangeGateState, type DomainAction } from "../src/domain/engine";

const gateway = {
  proposalId: "proposal-agent-gateway-restart",
  target: "agent-gateway",
  action: "RESTART_SIMULATED_GATEWAY",
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: ["agent-gateway is DEGRADED"],
} as const satisfies FlagshipChangeInput;

// Captured with the original constructor at accepted Gate 3 SHA 6c0d733.
const GATEWAY_DIGEST = "7aef4f4788217032d978d4aebecdf6f7e0ff4b241723eb27a2887eaa8ba3a37a";

const refund = {
  proposalId: "refund-order-4821",
  target: "order:4821",
  action: "SYNTHETIC_PARTIAL_REFUND",
  parameters: { currency: "USD", amountCents: 2500 },
  preconditions: ["order:4821 refunded amount is 0 cents"],
} as const satisfies RefundProposalInput;

type BeginRefund = Extract<DomainAction, { type: "BEGIN_REFUND_EXECUTION" }>;

const invalidReservedPairings = [
  { ...gateway, action: refund.action },
  { ...refund, action: gateway.action },
] as const;

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  if (!result.ok) throw new Error(`Unexpected denial: ${result.error.action}`);
  return result.state;
}

function expectDenied(state: ChangeGateState, action: DomainAction): void {
  const before = structuredClone(state);
  const audit = state.audit;
  const change = state.change;
  expect(reduceChangeGate(state, action)).toEqual({
    ok: false,
    error: { code: "ILLEGAL_TRANSITION", action: action.type, currentState: state.change?.status ?? "NONE" },
  });
  expect(state).toEqual(before);
  expect(state.audit).toBe(audit);
  expect(state.change).toBe(change);
}

function awaiting(proposal: ChangeProposalInput = refund, state = createInitialState()): ChangeGateState {
  return apply(apply(state, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal }), {
    type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT", proposalId: proposal.proposalId,
  });
}

function approve(state = awaiting(), approvalId = "opaque:approval:[1]"): ChangeGateState {
  const change = state.change;
  if (change?.status !== "AWAITING_HUMAN_APPROVAL") throw new Error("Expected pending review.");
  return apply(state, {
    type: "HUMAN_APPROVE", proposalId: change.proposal.proposalId,
    proposalDigest: change.proposal.proposalDigest, reviewInstanceId: change.reviewInstanceId, approvalId,
  });
}

function begin(state: ChangeGateState): BeginRefund {
  const change = state.change;
  if (change?.status !== "APPROVED") throw new Error("Expected approval.");
  return {
    type: "BEGIN_REFUND_EXECUTION",
    expectedProposalId: change.proposal.proposalId,
    expectedProposalDigest: change.proposal.proposalDigest,
    expectedReviewInstanceId: change.reviewInstanceId,
    expectedApprovalId: change.approval.approvalId,
  };
}

function executing(state = approve()): ChangeGateState {
  return apply(state, begin(state));
}

function executionId(state: ChangeGateState): string {
  const change = state.change;
  if (change === null || !("refundExecution" in change)) throw new Error("Expected refund binding.");
  return change.refundExecution.executionId;
}

describe("Gate 4 bounded refund authority", () => {
  it("preserves the exact pre-adaptation gateway digest", () => {
    expect(computeProposalDigest(gateway)).toBe(GATEWAY_DIGEST);
    expect(createImmutableProposal(gateway).proposalDigest).toBe(GATEWAY_DIGEST);
  });

  it("preserves the gateway projection values, detachment, and freezing", () => {
    const operations = createChangeGateOperations();
    operations.proposeChange(gateway);
    const first = operations.getChangeProposal();
    const second = operations.getChangeProposal();
    expect(first).toEqual({ ...gateway, lifecycle: "PROPOSED", proposalDigest: GATEWAY_DIGEST });
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(first?.parameters).not.toBe(second?.parameters);
    expect(first?.parameters).not.toBe(gateway.parameters);
    expect(first?.preconditions).not.toBe(gateway.preconditions);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.parameters)).toBe(true);
    expect(Object.isFrozen(first?.preconditions)).toBe(true);
  });

  it("widens only the read target contract and retains the seven gateway-only operation signatures", () => {
    expectTypeOf<"order:4821">().toExtend<ChangeProposalProjection["target"]>();
    expectTypeOf<Parameters<ChangeGateWebMcpOperations["proposeChange"]>[0]>().toEqualTypeOf<FlagshipChangeInput>();
    expectTypeOf<RefundProposalInput>().not.toExtend<FlagshipChangeInput>();
    expect(Object.keys(createWebMcpOperationsFacade(createChangeGateOperations())).sort()).toEqual([
      "getAuditTrail", "getChangePolicy", "getChangeProposal", "getEnvironmentStatus",
      "getServiceDetails", "proposeChange", "requestChangeApproval",
    ]);
  });

  it("constructs a strict frozen refund and binds every canonical field", () => {
    const proposal = createImmutableProposal(refund);
    expectTypeOf(proposal).toEqualTypeOf<ImmutableRefundProposal>();
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.parameters)).toBe(true);
    expect(Object.isFrozen(proposal.preconditions)).toBe(true);
    for (const alternative of [
      { ...refund, proposalId: "another" },
      { ...refund, target: "agent-gateway" },
      { ...refund, action: "OTHER" },
      { ...refund, parameters: { currency: "USD", amountCents: 2000 } },
      { ...refund, preconditions: ["different"] },
    ]) {
      expect(computeProposalDigest(alternative as ChangeProposalInput)).not.toBe(proposal.proposalDigest);
    }
  });

  it.each(invalidReservedPairings)("rejects reserved action/target cross-pairing at construction: %j", (input) => {
    expect(() => createImmutableProposal(input as ChangeProposalInput)).toThrow(TypeError);
  });

  it.each(invalidReservedPairings)("denies both execution paths for a cross-paired forged approval: %j", (input) => {
    const approved = approve();
    if (approved.change?.status !== "APPROVED") throw new Error("Expected approval.");
    // Bypass construction deliberately, keeping digest and human authority consistent.
    const proposal = {
      ...input, proposalDigest: computeProposalDigest(input as ChangeProposalInput),
    } as ImmutableChangeProposal;
    const approval: HumanApproval = { ...approved.change.approval, ...proposal };
    const forgedState: ChangeGateState = { ...approved, change: { ...approved.change, proposal, approval } };
    expect(isApprovalBoundToProposal(approval, proposal)).toBe(true);
    expectDenied(forgedState, { type: "BEGIN_EXECUTION" });
    expectDenied(forgedState, begin(forgedState));
  });

  it("retains the trusted review identity without parsing the opaque approval ID", () => {
    const pending = awaiting();
    const approved = approve(pending);
    if (pending.change?.status !== "AWAITING_HUMAN_APPROVAL" || approved.change?.status !== "APPROVED") {
      throw new Error("Expected approval transition.");
    }
    expect(approved.change.approval).toEqual({
      ...pending.change.proposal, reviewInstanceId: pending.change.reviewInstanceId,
      approvalId: "opaque:approval:[1]", issuedBy: "HUMAN", status: "ACTIVE",
    });
  });

  it("atomically consumes approval and derives an immutable exact $25 effect and execution identity", () => {
    const approved = approve();
    const state = executing(approved);
    const change = state.change;
    if (approved.change?.status !== "APPROVED" || change?.status !== "EXECUTING" || change.executionKind !== "REFUND") {
      throw new Error("Expected refund execution.");
    }
    expect(change.proposal).toBe(approved.change.proposal);
    expect(change.approval).toEqual({ ...approved.change.approval, status: "CONSUMED" });
    expect(approved.change.approval.status).toBe("ACTIVE");
    expect(change.refundExecution).toEqual({
      executionId: JSON.stringify(["refund-execution-v1", approved.change.reviewInstanceId, approved.change.approval.approvalId]),
      proposalId: refund.proposalId, proposalDigest: computeProposalDigest(refund),
      reviewInstanceId: approved.change.reviewInstanceId, approvalId: approved.change.approval.approvalId,
      effect: { operation: refund.action, orderId: "4821", currency: "USD", amountCents: 2500 },
    });
    expect(Object.isFrozen(change.approval)).toBe(true);
    expect(Object.isFrozen(change.refundExecution)).toBe(true);
    expect(Object.isFrozen(change.refundExecution.effect)).toBe(true);
    expect(state.environment).toBe(approved.environment);
    expect(state.audit).toHaveLength(approved.audit.length + 1);
    expect(executing(approved)).toEqual(state);
  });

  it("has an identity-only begin contract with no caller execution ID or business values", () => {
    expectTypeOf<keyof BeginRefund>().toEqualTypeOf<
      "type" | "expectedProposalId" | "expectedProposalDigest" | "expectedReviewInstanceId" | "expectedApprovalId"
    >();
    expectTypeOf<Extract<DomainAction, { type: "REFUND_VERIFICATION_SUCCEEDED" }>>().toEqualTypeOf<never>();
  });

  it.each(["amountCents", "orderId", "currency", "action", "policyMaximumCents", "effect", "executionId"])(
    "denies runtime substitution field %s without consuming approval", (field) => {
      const approved = approve();
      expectDenied(approved, { ...begin(approved), [field]: "substituted" });
    },
  );

  it.each(["expectedProposalId", "expectedProposalDigest", "expectedReviewInstanceId", "expectedApprovalId"] as const)(
    "denies an incorrect %s without state or audit mutation", (field) => {
      const approved = approve();
      expectDenied(approved, { ...begin(approved), [field]: "wrong" });
    },
  );

  it("denies begin before approval, after rejection/expiry, and on the gateway proposal", () => {
    const identity = begin(approve());
    const proposed = apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: refund });
    const pending = awaiting();
    if (pending.change?.status !== "AWAITING_HUMAN_APPROVAL") throw new Error("Expected review.");
    const rejected = apply(pending, {
      type: "HUMAN_REJECT", proposalId: refund.proposalId, proposalDigest: computeProposalDigest(refund),
      reviewInstanceId: pending.change.reviewInstanceId,
    });
    for (const state of [createInitialState(), proposed, pending, rejected, apply(pending, { type: "EXPIRE_PROPOSAL" })]) {
      expectDenied(state, identity);
    }
    const gatewayApproved = approve(awaiting(gateway));
    expectDenied(gatewayApproved, begin(gatewayApproved));
    expectDenied(approve(), { type: "BEGIN_EXECUTION" });
  });

  it.each([0, -1, 0.5, 3001, 12900, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "denies approved amount %s outside the trusted positive-safe-integer/policy bounds", (amountCents) => {
      const approved = approve(awaiting({ ...refund, parameters: { currency: "USD", amountCents } }));
      expectDenied(approved, begin(approved));
    },
  );

  it.each([1, 2000, 3000])("derives the exact approved amount %s within policy", (amountCents) => {
    const state = executing(approve(awaiting({ ...refund, parameters: { currency: "USD", amountCents } })));
    expect(state.change).toMatchObject({ refundExecution: { effect: { amountCents } } });
  });

  it.each([NaN, Infinity, -Infinity])("preserves JSON rejection and fails closed on non-finite amount %s", (amountCents) => {
    const input = { ...refund, parameters: { currency: "USD" as const, amountCents } };
    expect(() => createImmutableProposal(input)).toThrow("Proposal numbers must be finite.");
    const state = approve();
    if (state.change?.status !== "APPROVED") throw new Error("Expected approval.");
    const forgedState: ChangeGateState = {
      ...state, change: { ...state.change, proposal: { ...input, proposalDigest: state.change.proposal.proposalDigest } },
    };
    expectDenied(forgedState, begin(state));
  });

  it.each([
    { ...refund, action: "OTHER" },
    { ...refund, parameters: { currency: "EUR", amountCents: 2500 } },
    { ...refund, parameters: { currency: "USD", amountCents: 2500, policyMaximumCents: 99999 } },
    { ...refund, parameters: { currency: "USD", amountCents: "2500" } },
    { ...refund, preconditions: [] },
    { ...refund, preconditions: ["order:4821 refunded amount is 2000 cents"] },
  ])("rejects invalid refund shape at construction and at the authority boundary: %j", (input) => {
    expect(() => createImmutableProposal(input as RefundProposalInput)).toThrow(TypeError);
    const state = approve();
    if (state.change?.status !== "APPROVED") throw new Error("Expected approval.");
    const forged = { ...input, proposalDigest: computeProposalDigest(input as RefundProposalInput) } as ImmutableRefundProposal;
    const forgedState: ChangeGateState = {
      ...state, change: { ...state.change, proposal: forged, approval: { ...state.change.approval, ...forged } },
    };
    expectDenied(forgedState, begin(forgedState));
  });

  it.each([
    { issuedBy: "AGENT" }, { status: "CONSUMED" }, { status: "INVALIDATED" },
    { status: "EXPIRED" }, { status: "REJECTED" }, { reviewInstanceId: "other-review" },
    { proposalId: "other-proposal" }, { proposalDigest: "other-digest" },
    { target: "agent-gateway" }, { action: "OTHER" },
    { parameters: { currency: "USD", amountCents: 2000 } }, { preconditions: ["OTHER"] },
  ])("denies approval binding tampering: %j", (replacement) => {
    const state = approve();
    if (state.change?.status !== "APPROVED") throw new Error("Expected approval.");
    const forgedState: ChangeGateState = {
      ...state, change: { ...state.change, approval: { ...state.change.approval, ...replacement } as HumanApproval },
    };
    expectDenied(forgedState, begin(state));
  });

  it("denies a second begin and reset during execution or verification", () => {
    const approved = approve();
    const active = executing(approved);
    expectDenied(active, begin(approved));
    expectDenied(active, { type: "RESET_SCENARIO" });
    const verifying = apply(active, { type: "REFUND_EXECUTION_SUCCEEDED", executionId: executionId(active) });
    expectDenied(verifying, begin(approved));
    expectDenied(verifying, { type: "RESET_SCENARIO" });
  });

  it("denies stale Execute after byte-identical reproposal with the same opaque approval ID", () => {
    const first = approve();
    const second = approve(awaiting(refund, apply(first, { type: "RESET_SCENARIO" })));
    expect(first.change?.proposal).toEqual(second.change?.proposal);
    expect(begin(second).expectedApprovalId).toBe(begin(first).expectedApprovalId);
    expect(begin(second).expectedReviewInstanceId).not.toBe(begin(first).expectedReviewInstanceId);
    expectDenied(second, begin(first));
    expect(executionId(executing(second))).not.toBe(executionId(executing(first)));
  });

  it.each(["REFUND_EXECUTION_SUCCEEDED", "REFUND_EXECUTION_FAILED"] as const)(
    "denies wrong and previous-lifecycle execution IDs on %s", (type) => {
      const first = executing();
      const failed = apply(first, { type: "REFUND_EXECUTION_FAILED", executionId: executionId(first) });
      const second = executing(approve(awaiting(refund, apply(failed, { type: "RESET_SCENARIO" }))));
      expectDenied(second, { type, executionId: "wrong" });
      expectDenied(second, { type, executionId: executionId(first) });
      const gatewayActive = apply(approve(awaiting(gateway)), { type: "BEGIN_EXECUTION" });
      expectDenied(gatewayActive, { type, executionId: executionId(second) });
    },
  );

  it("allows exact execution completion once, retains binding, and stops at VERIFYING", () => {
    const active = executing();
    const completion = { type: "REFUND_EXECUTION_SUCCEEDED", executionId: executionId(active) } as const;
    const verifying = apply(active, completion);
    expect(verifying.change).toEqual({ ...active.change, status: "VERIFYING" });
    expect(verifying.environment).toBe(active.environment);
    expectDenied(verifying, completion);
    expectDenied(verifying, { type: "REFUND_EXECUTION_FAILED", executionId: completion.executionId });
    for (const type of ["EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "VERIFICATION_SUCCEEDED", "VERIFICATION_FAILED"] as const) {
      expectDenied(active, { type });
      expectDenied(verifying, { type });
    }
  });

  it("retains consumed authority and failure stage without retry or legacy rollback", () => {
    const approved = approve();
    const active = executing(approved);
    const failure = { type: "REFUND_EXECUTION_FAILED", executionId: executionId(active) } as const;
    const failed = apply(active, failure);
    expect(failed.change).toEqual({ ...active.change, status: "FAILED", failureStage: "EXECUTION" });
    expect(failed.change).toMatchObject({ approval: { status: "CONSUMED" } });
    expectDenied(failed, failure);
    expectDenied(failed, { type: "REFUND_EXECUTION_SUCCEEDED", executionId: failure.executionId });
    expectDenied(failed, begin(approved));
    expectDenied(failed, { type: "REQUEST_ROLLBACK_APPROVAL", actor: "HUMAN" });
  });
});
