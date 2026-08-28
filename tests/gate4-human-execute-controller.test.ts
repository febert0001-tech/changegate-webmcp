import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createChangeGateOperations, createWebMcpOperationsFacade,
  type ChangeGateOperations, type ChangeGateWebMcpOperations, type HumanExecuteIdentity,
} from "../src/application/changegate-operations";
import * as ledgerModule from "../src/application/synthetic-refund-ledger";
import * as verifierModule from "../src/application/refund-verifier";
import * as engine from "../src/domain/engine";
import type { ChangeProposalInput, RefundExecutionBinding } from "../src/domain/change/contracts";
import { GATE_2_TOOL_NAMES } from "../src/webmcp/tool-catalog";

const refund = {
  proposalId: "refund-order-4821", target: "order:4821", action: "SYNTHETIC_PARTIAL_REFUND",
  parameters: { currency: "USD", amountCents: 2500 },
  preconditions: ["order:4821 refunded amount is 0 cents"],
} as const;
const gateway = {
  proposalId: "gateway", target: "agent-gateway", action: "RESTART_SIMULATED_GATEWAY",
  parameters: { mode: "safe", retryLimit: 1 }, preconditions: ["agent-gateway is DEGRADED"],
} as const;
const keys = ["proposalId", "proposalDigest", "reviewInstanceId", "approvalId"] as const;
const realInitial = engine.createInitialState;
const realReduce = engine.reduceChangeGate;
const realLedger = ledgerModule.createSyntheticRefundLedger;
const realVerifier = verifierModule.createRefundVerifier;

function apply(state: engine.ChangeGateState, action: engine.DomainAction): engine.ChangeGateState {
  const result = realReduce(state, action);
  if (!result.ok) throw new Error(`Unexpected denial: ${action.type}`);
  return result.state;
}

function review(proposal: ChangeProposalInput = refund, initial = realInitial()) {
  const proposed = apply(initial, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal });
  return apply(proposed, { type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT", proposalId: proposal.proposalId });
}

type WriteMode = "normal" | "reject" | "throw" | "write-then-throw" | "already";
type ReadMode = "normal" | "mismatch" | "empty" | "malformed" | "throw";

// Module spies are TEST-only instrumentation. Production has no state/dependency seam.
function setup(initial = review(), writeMode: WriteMode = "normal", readMode: ReadMode = "normal") {
  const ledger = realLedger();
  const initialSpy = vi.spyOn(engine, "createInitialState").mockReturnValue(initial);
  const reducer = vi.spyOn(engine, "reduceChangeGate");
  const state = (): engine.ChangeGateState => {
    for (const call of [...reducer.mock.results].reverse()) {
      if (call.type === "return" && call.value.ok) return call.value.state;
    }
    return initial;
  };
  const sequence: string[] = [];
  const writeObservations: { state: engine.ChangeGateState; lifecycle: string | undefined; revision: number }[] = [];
  const write = vi.fn((binding: RefundExecutionBinding): ledgerModule.RefundWriteResult => {
    sequence.push("WRITE");
    writeObservations.push({ state: state(), lifecycle: operations.getChangeProposal()?.lifecycle, revision: operations.getRevision() });
    if (writeMode === "throw") throw new Error("Writer unavailable");
    if (writeMode === "reject") return { status: "REJECTED", reason: "PRECONDITION_FAILED" };
    const result = ledger.writer.applyAuthorizedRefund(binding);
    if (writeMode === "write-then-throw") throw new Error("Ambiguous write completion");
    // Exercise real deduplication, not a fabricated idempotence claim.
    if (writeMode === "already") return ledger.writer.applyAuthorizedRefund(binding);
    return result;
  });
  const read = vi.fn((orderId: "4821") => {
    sequence.push("READ");
    if (readMode === "throw") throw new Error("Read unavailable");
    const snapshot = ledger.reader.readRefundState(orderId);
    if (readMode === "mismatch") return {
      ...snapshot, refundedAmountCents: 2000,
      transactions: snapshot.transactions.map((transaction) => ({ ...transaction, amountCents: 2000 })),
    };
    if (readMode === "empty") return { ...snapshot, refundedAmountCents: 0, transactionCount: 0, transactions: [] };
    if (readMode === "malformed") return { ...snapshot, transactionCount: 2 };
    return snapshot;
  });
  const reader = { readRefundState: read };
  const ledgerFactory = vi.spyOn(ledgerModule, "createSyntheticRefundLedger")
    .mockReturnValue({ writer: { applyAuthorizedRefund: write }, reader });
  const composed = realVerifier(reader);
  const verificationObservations: { state: engine.ChangeGateState; lifecycle: string | undefined }[] = [];
  const verify = vi.fn((binding: RefundExecutionBinding) => {
    verificationObservations.push({ state: state(), lifecycle: operations.getChangeProposal()?.lifecycle });
    return composed.verify(binding);
  });
  const verifierFactory = vi.spyOn(verifierModule, "createRefundVerifier").mockImplementation((capturedReader) => {
    expect(capturedReader).toBe(reader);
    return { verify };
  });
  const operations = createChangeGateOperations();
  const publications: { state: engine.ChangeGateState; lifecycle: string | undefined }[] = [];
  operations.subscribe(() => {
    const lifecycle = operations.getChangeProposal()?.lifecycle;
    publications.push({ state: state(), lifecycle });
    sequence.push(lifecycle!);
  });
  return { operations, ledger, write, read, verify, state, reducer, sequence, publications,
    writeObservations, verificationObservations, initialSpy, ledgerFactory, verifierFactory };
}

function approve(context: ReturnType<typeof setup>): HumanExecuteIdentity {
  expect(context.operations.approvePendingChange().status).toBe("SUCCESS");
  const identity = context.operations.getPendingRefundExecution();
  if (identity === null) throw new Error("Expected refund execute identity");
  return identity;
}

function expectPreflightDenied(context: ReturnType<typeof setup>, input: unknown) {
  const { operations, write, verify } = context;
  const beforeState = context.state();
  const audit = operations.getAuditTrail();
  const revision = operations.getRevision();
  expect(operations.executeApprovedRefund(input as HumanExecuteIdentity)).toMatchObject({ status: "DENIED" });
  expect(context.state()).toBe(beforeState);
  expect(operations.getAuditTrail()).toEqual(audit);
  expect(operations.getRevision()).toBe(revision);
  expect(write).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(context.ledger.reader.readRefundState("4821").transactionCount).toBe(0);
}

afterEach(() => vi.restoreAllMocks());

describe("Gate 4 Unit 3 human Execute orchestration", () => {
  it("completes with unmodified production ledger and verifier factories", () => {
    vi.spyOn(engine, "createInitialState").mockReturnValue(review());
    const operations = createChangeGateOperations();
    expect(operations.approvePendingChange().status).toBe("SUCCESS");
    const identity = operations.getPendingRefundExecution();
    if (!identity) throw new Error("Expected approval");
    expect(operations.executeApprovedRefund(identity)).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "SUCCEEDED" } });
    expect(operations.getAuditTrail().events.at(-1)).toMatchObject({ type: "REFUND_VERIFICATION_COMPLETED", lifecycle: "SUCCEEDED" });
  });

  it.each(["consumed", "issuer", "approval-proposal", "approval-digest", "approval-review", "proposal-digest", "unsupported-refund"])(
    "hides execution identity and denies incoherent approval: %s", (kind) => {
      const pending = review();
      if (pending.change?.status !== "AWAITING_HUMAN_APPROVAL") throw new Error("Expected review");
      const approved = apply(pending, {
        type: "HUMAN_APPROVE", proposalId: refund.proposalId, proposalDigest: pending.change.proposal.proposalDigest,
        reviewInstanceId: pending.change.reviewInstanceId, approvalId: "approval",
      });
      if (approved.change?.status !== "APPROVED") throw new Error("Expected approval");
      const change = approved.change;
      const identity = {
        proposalId: change.proposal.proposalId, proposalDigest: change.proposal.proposalDigest,
        reviewInstanceId: change.reviewInstanceId, approvalId: change.approval.approvalId,
      };
      const altered = {
        ...approved, change: { ...change, approval: { ...change.approval }, proposal: { ...change.proposal } },
      };
      switch (kind) {
        case "consumed": altered.change.approval.status = "CONSUMED"; break;
        case "issuer": Reflect.set(altered.change.approval, "issuedBy", "AGENT"); break;
        case "approval-proposal": altered.change.approval.proposalId = "other"; break;
        case "approval-digest": altered.change.approval.proposalDigest = "other"; break;
        case "approval-review": altered.change.approval.reviewInstanceId = "other"; break;
        case "proposal-digest": altered.change.proposal.proposalDigest = "other"; break;
        case "unsupported-refund": altered.change.proposal.parameters = { currency: "USD", amountCents: 3100 }; break;
      }
      const context = setup(altered);
      expect(context.operations.getPendingRefundExecution()).toBeNull();
      expectPreflightDenied(context, identity);
    },
  );

  it("projects only four frozen identity fields from a coherent active refund approval", () => {
    const context = setup();
    expect(context.operations.getPendingRefundExecution()).toBeNull();
    const identity = approve(context);
    expect(Reflect.ownKeys(identity).sort()).toEqual([...keys].sort());
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity).toMatchObject({ proposalId: refund.proposalId, approvalId: "human-ui:human-review:1" });
    expect(context.state().change).toMatchObject({ status: "APPROVED", approval: { status: "ACTIVE" } });
    expect(Reflect.set(identity, "approvalId", "substitute")).toBe(false);
    expect(context.operations.getPendingRefundExecution()).toEqual(identity);
  });

  it("commits consumed authority before writing, then verifies the exact reducer binding and $25 transaction", () => {
    const context = setup();
    const identity = approve(context);
    const result = context.operations.executeApprovedRefund(identity);
    expect(result).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "SUCCEEDED" } });
    expect(context.sequence).toEqual(["APPROVED", "EXECUTING", "WRITE", "VERIFYING", "READ", "SUCCEEDED"]);
    const [written] = context.writeObservations;
    expect(written).toMatchObject({ lifecycle: "EXECUTING", revision: 2, state: { change: { approval: { status: "CONSUMED" } } } });
    expect(context.publications[1]!.state).toBe(written!.state);
    const change = written!.state.change;
    if (change?.status !== "EXECUTING" || change.executionKind !== "REFUND") throw new Error("Expected execution");
    const binding = change.refundExecution;
    expect(context.write).toHaveBeenCalledExactlyOnceWith(binding);
    expect(context.write.mock.calls[0]![0]).toBe(binding);
    expect(context.verify).toHaveBeenCalledTimes(1);
    expect(context.verify.mock.calls[0]![0]).toBe(binding);
    expect(context.verify.mock.calls[0]).toHaveLength(1);
    expect(context.verificationObservations[0]!.lifecycle).toBe("VERIFYING");
    expect(context.publications[2]!.state).toBe(context.verificationObservations[0]!.state);
    const evidence = context.verify.mock.results[0]!.value;
    expect(context.state().change).toMatchObject({ status: "SUCCEEDED", verificationEvidence: { result: "VERIFIED" } });
    const terminal = context.state().change;
    if (terminal?.status !== "SUCCEEDED" || terminal.executionKind !== "REFUND") throw new Error("Expected terminal refund");
    expect(terminal.verificationEvidence).toBe(evidence);
    expect(evidence.authorization).toBe(binding);
    expect(terminal.refundExecution).toBe(binding);
    expect(evidence.observed).toEqual({
      orderId: "4821", currency: "USD", refundedAmountCents: 2500, transactionCount: 1,
      transactions: [{ executionId: binding.executionId, ...binding.effect }],
    });
    expect(context.ledger.reader.readRefundState("4821")).toEqual(evidence.observed);
    expect(context.operations.getAuditTrail().events.slice(-3)).toEqual([
      { sequence: 4, actor: "SYSTEM", type: "BEGIN_REFUND_EXECUTION", lifecycle: "EXECUTING" },
      { sequence: 5, actor: "SYSTEM", type: "REFUND_EXECUTION_SUCCEEDED", lifecycle: "VERIFYING" },
      { sequence: 6, actor: "SYSTEM", type: "REFUND_VERIFICATION_COMPLETED", lifecycle: "SUCCEEDED" },
    ]);
    expect(context.operations.getPendingRefundExecution()).toBeNull();
    expect(context.initialSpy).toHaveBeenCalledTimes(1);
    expect(context.ledgerFactory).toHaveBeenCalledTimes(1);
    expect(context.verifierFactory).toHaveBeenCalledTimes(1);
    const begin = context.reducer.mock.calls.find(([, action]) => action.type === "BEGIN_REFUND_EXECUTION")![1];
    expect(Reflect.ownKeys(begin).sort()).toEqual([
      "type", "expectedProposalId", "expectedProposalDigest", "expectedReviewInstanceId", "expectedApprovalId",
    ].sort());
  });

  it("denies duplicate terminal Execute without another write, read, revision, or terminal audit event", () => {
    const context = setup();
    const identity = approve(context);
    context.operations.executeApprovedRefund(identity);
    const audit = context.operations.getAuditTrail();
    const revision = context.operations.getRevision();
    expect(context.operations.executeApprovedRefund(identity).status).toBe("DENIED");
    expect(context.operations.getAuditTrail()).toEqual(audit);
    expect(context.operations.getRevision()).toBe(revision);
    expect(context.write).toHaveBeenCalledTimes(1);
    expect(context.verify).toHaveBeenCalledTimes(1);
    expect(context.read).toHaveBeenCalledTimes(1);
    expect(context.ledger.reader.readRefundState("4821").transactionCount).toBe(1);
  });

  it.each(keys)("denies wrong %s before consuming approval or writing", (key) => {
    const context = setup();
    const identity = approve(context);
    expectPreflightDenied(context, { ...identity, [key]: "wrong" });
    expect(context.state().change).toMatchObject({ status: "APPROVED", approval: { status: "ACTIVE" } });
  });

  it.each(keys)("denies missing %s", (key) => {
    const context = setup();
    const input: Partial<HumanExecuteIdentity> = { ...approve(context) };
    Reflect.deleteProperty(input, key);
    expectPreflightDenied(context, input);
  });

  it.each(["amountCents", "orderId", "currency", "action", "policyMaximum", "transaction", "executionId",
    "observed", "result", "receipt", "ledger", "reader", "verifier"])("denies extra %s", (key) => {
    const context = setup();
    expectPreflightDenied(context, { ...approve(context), [key]: "substitute" });
  });

  it.each(["inherited", "symbol", "hidden-extra", "hidden-identity", "accessor", "revoked-proxy", "throwing-proxy",
    "null", "undefined", "array", "empty-string", "number"])("denies malformed input: %s", (kind) => {
    const context = setup();
    const identity = approve(context);
    let input: unknown = { ...identity };
    const getter = vi.fn(() => identity.approvalId);
    switch (kind) {
      case "inherited": input = Object.create(identity); break;
      case "symbol": Object.defineProperty(input, Symbol("authority"), { value: 1 }); break;
      case "hidden-extra": Object.defineProperty(input, "amountCents", { value: 2000 }); break;
      case "hidden-identity": Object.defineProperty(input, "approvalId", { enumerable: false }); break;
      case "accessor": Object.defineProperty(input, "approvalId", { get: getter }); break;
      case "revoked-proxy": { const proxy = Proxy.revocable(identity, {}); proxy.revoke(); input = proxy.proxy; break; }
      case "throwing-proxy": input = new Proxy(identity, { ownKeys() { throw new Error("no"); } }); break;
      case "null": input = null; break;
      case "undefined": input = undefined; break;
      case "array": input = []; break;
      case "empty-string": input = { ...identity, approvalId: "" }; break;
      case "number": input = { ...identity, approvalId: 1 }; break;
    }
    expectPreflightDenied(context, input);
    expect(getter).not.toHaveBeenCalled();
    expect(context.state().change).toMatchObject({ status: "APPROVED", approval: { status: "ACTIVE" } });
  });

  it("denies stale lifecycle N intent after terminal/reset/reproposal, then executes current N+1", () => {
    const old = setup(review(), "reject");
    const stale = approve(old);
    expect(old.operations.executeApprovedRefund(stale)).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "FAILED" } });
    const reset = apply(old.state(), { type: "RESET_SCENARIO" });
    // No application reset API is added for this test; use the accepted domain fixture path.
    vi.restoreAllMocks();
    const current = setup(review(refund, reset));
    const identity = approve(current);
    expect(identity.proposalId).toBe(stale.proposalId);
    expect(identity.proposalDigest).toBe(stale.proposalDigest);
    expect(identity.reviewInstanceId).not.toBe(stale.reviewInstanceId);
    expectPreflightDenied(current, stale);
    expect(current.state().change).toMatchObject({ status: "APPROVED", approval: { status: "ACTIVE" } });
    expect(current.operations.executeApprovedRefund(identity)).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "SUCCEEDED" } });
  });

  it.each(["NONE", "PROPOSED", "AWAITING_HUMAN_APPROVAL", "REJECTED"])("denies Execute in %s", (status) => {
    let initial = realInitial();
    if (status !== "NONE") initial = apply(initial, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: refund });
    if (status === "AWAITING_HUMAN_APPROVAL" || status === "REJECTED") initial = review();
    const context = setup(initial);
    if (status === "REJECTED") expect(context.operations.rejectPendingChange().status).toBe("SUCCESS");
    expect(context.operations.getPendingRefundExecution()).toBeNull();
    expectPreflightDenied(context, { proposalId: refund.proposalId, proposalDigest: "digest", reviewInstanceId: "review", approvalId: "approval" });
  });

  it("denies an approved gateway even with its exact approval identity", () => {
    const context = setup(review(gateway));
    expect(context.operations.approvePendingChange().status).toBe("SUCCESS");
    const change = context.state().change;
    if (change?.status !== "APPROVED") throw new Error("Expected approval");
    expect(context.operations.getPendingRefundExecution()).toBeNull();
    expectPreflightDenied(context, {
      proposalId: change.proposal.proposalId, proposalDigest: change.proposal.proposalDigest,
      reviewInstanceId: change.reviewInstanceId, approvalId: change.approval.approvalId,
    });
  });

  it.each(["reject", "throw", "write-then-throw"] as const)("fails closed for writer %s, skips verification, and denies retry", (mode) => {
    const context = setup(review(), mode);
    const identity = approve(context);
    expect(context.operations.executeApprovedRefund(identity)).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "FAILED" } });
    expect(context.state().change).toMatchObject({ status: "FAILED", failureStage: "EXECUTION", approval: { status: "CONSUMED" } });
    expect(context.operations.getAuditTrail().events.at(-1)?.type).toBe("REFUND_EXECUTION_FAILED");
    expect(context.verify).not.toHaveBeenCalled();
    expect(context.read).not.toHaveBeenCalled();
    const audit = context.operations.getAuditTrail();
    expect(context.operations.executeApprovedRefund(identity).status).toBe("DENIED");
    expect(context.operations.getAuditTrail()).toEqual(audit);
    expect(context.write).toHaveBeenCalledTimes(1);
    expect(context.ledger.reader.readRefundState("4821").transactionCount).toBe(mode === "write-then-throw" ? 1 : 0);
  });

  it("accepts writer-proven ALREADY_APPLIED with exactly one transaction", () => {
    const context = setup(review(), "already");
    expect(context.operations.executeApprovedRefund(approve(context))).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "SUCCEEDED" } });
    expect(context.write.mock.results[0]!.value).toEqual({ status: "ALREADY_APPLIED" });
    expect(context.ledger.reader.readRefundState("4821").transactionCount).toBe(1);
  });

  it.each(["mismatch", "empty", "malformed", "throw"] as const)("uses authentic verifier evidence for reader %s", (mode) => {
    const context = setup(review(), "normal", mode);
    expect(context.operations.executeApprovedRefund(approve(context))).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "FAILED" } });
    expect(context.state().change).toMatchObject({
      status: "FAILED", failureStage: "VERIFICATION", approval: { status: "CONSUMED" },
      verificationEvidence: { result: "MISMATCH", reason: mode === "throw" ? "READ_FAILED" : "LEDGER_MISMATCH" },
    });
    expect(context.operations.getAuditTrail().events.at(-1)?.type).toBe("REFUND_VERIFICATION_COMPLETED");
    expect(context.verify).toHaveBeenCalledTimes(1);
  });

  it("denies reentrant subscriber Execute while publishing EXECUTING/VERIFYING and tolerates listener exceptions", () => {
    const context = setup();
    const identity = approve(context);
    const attempts: string[] = [];
    context.operations.subscribe(() => {
      attempts.push(context.operations.executeApprovedRefund(identity).status);
      throw new Error("Listener unavailable");
    });
    expect(context.operations.executeApprovedRefund(identity)).toMatchObject({ status: "SUCCESS", proposal: { lifecycle: "SUCCEEDED" } });
    expect(attempts).toEqual(["DENIED", "DENIED", "DENIED"]);
    expect(context.write).toHaveBeenCalledTimes(1);
    expect(context.verify).toHaveBeenCalledTimes(1);
  });

  it("keeps human Execute and private dependencies out of the frozen seven-operation WebMCP facade", () => {
    const operations = createChangeGateOperations();
    const facade = createWebMcpOperationsFacade(operations);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.isFrozen(operations)).toBe(true);
    expect(Reflect.ownKeys(facade).sort()).toEqual([
      "getEnvironmentStatus", "getServiceDetails", "getChangePolicy", "getChangeProposal", "getAuditTrail",
      "proposeChange", "requestChangeApproval",
    ].sort());
    for (const key of ["ledger", "reader", "writer", "verifier", "createRefundVerifier", "dispatch"]) {
      expect(key in operations).toBe(false);
      expect(key in facade).toBe(false);
    }
    for (const key of ["getPendingRefundExecution", "executeApprovedRefund"]) expect(key in facade).toBe(false);
    expect(GATE_2_TOOL_NAMES).toEqual([
      "get_environment_status", "get_service_details", "get_change_policy", "get_change_proposal", "get_audit_trail",
      "propose_change", "request_change_approval",
    ]);
    expectTypeOf<keyof HumanExecuteIdentity>().toEqualTypeOf<typeof keys[number]>();
    expectTypeOf<Parameters<ChangeGateOperations["executeApprovedRefund"]>>().toEqualTypeOf<[HumanExecuteIdentity]>();
    expectTypeOf<Extract<keyof ChangeGateWebMcpOperations, "executeApprovedRefund" | "getPendingRefundExecution" | "reader" | "writer" | "ledger" | "verifier">>().toEqualTypeOf<never>();
    expect(operations.executeApprovedRefund).toHaveLength(1);
    expect(createChangeGateOperations).toHaveLength(0);
  });
});
