import { describe, expect, it } from "vitest";

import { computeProposalDigest, createImmutableProposal } from "./change/proposal-digest";
import {
  createInitialState,
  isApprovalBoundToProposal,
  reduceChangeGate,
  type ChangeGateState,
  type DomainAction,
} from "./engine";
import { CANONICAL_SCENARIO } from "./scenario/canonical-scenario";

const proposal = {
  proposalId: "proposal-agent-gateway-restart",
  target: "agent-gateway",
  action: "RESTART_SIMULATED_GATEWAY",
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: ["agent-gateway is DEGRADED"],
} as const;

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected transition failure: ${result.error.action}`);
  return result.state;
}

function expectDenied(state: ChangeGateState, action: DomainAction): void {
  const result = reduceChangeGate(state, action);
  expect(result).toEqual({
    ok: false,
    error: {
      code: "ILLEGAL_TRANSITION",
      action: action.type,
      currentState: state.change?.status ?? "NONE",
    },
  });
}

function awaitingApproval(): ChangeGateState {
  return apply(
    apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal }),
    { type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT" },
  );
}

function executing(): ChangeGateState {
  return apply(
    apply(awaitingApproval(), { type: "HUMAN_APPROVE", approvalId: "approval-1" }),
    { type: "BEGIN_EXECUTION" },
  );
}

function failed(): ChangeGateState {
  return apply(executing(), { type: "EXECUTION_FAILED" });
}

describe("deterministic ChangeGate domain engine", () => {
  it("creates an isolated runtime environment from the immutable canonical fixture", () => {
    const state = createInitialState();

    expect(state.environment.services).toEqual(CANONICAL_SCENARIO.services);
    expect(state.environment.services).not.toBe(CANONICAL_SCENARIO.services);
    expect(state.environment.services[0]).not.toBe(CANONICAL_SCENARIO.services[0]);
    expect(state.environment.services.filter(({ health }) => health === "DEGRADED")).toEqual([
      { id: "agent-gateway", displayName: "Agent Gateway", health: "DEGRADED" },
    ]);
  });

  it("follows the complete successful lifecycle with a consumed human approval", () => {
    let state = awaitingApproval();
    expect(state.change?.status).toBe("AWAITING_HUMAN_APPROVAL");

    state = apply(state, { type: "HUMAN_APPROVE", approvalId: "approval-1" });
    expect(state.change?.status).toBe("APPROVED");
    state = apply(state, { type: "BEGIN_EXECUTION" });
    expect(state.change?.status).toBe("EXECUTING");
    if (state.change?.status === "EXECUTING") expect(state.change.approval.status).toBe("CONSUMED");
    state = apply(state, { type: "EXECUTION_SUCCEEDED" });
    expect(state.change?.status).toBe("VERIFYING");
    state = apply(state, { type: "VERIFICATION_SUCCEEDED" });
    expect(state.change?.status).toBe("SUCCEEDED");
  });

  it("supports execution and verification failure without inventing an execution-failed state", () => {
    expect(apply(executing(), { type: "EXECUTION_FAILED" }).change).toMatchObject({
      status: "FAILED",
      failureStage: "EXECUTION",
    });

    const verifying = apply(executing(), { type: "EXECUTION_SUCCEEDED" });
    expect(apply(verifying, { type: "VERIFICATION_FAILED" }).change).toMatchObject({
      status: "FAILED",
      failureStage: "VERIFICATION",
    });
  });

  it("requires a separate human rollback approval and supports both rollback outcomes", () => {
    const awaitingRollback = apply(failed(), { type: "REQUEST_ROLLBACK_APPROVAL", actor: "AGENT" });
    expectDenied(awaitingRollback, { type: "BEGIN_ROLLBACK" });

    const approvedRollback = apply(awaitingRollback, {
      type: "HUMAN_APPROVE_ROLLBACK",
      approvalId: "rollback-approval-1",
    });
    const rollingBack = apply(approvedRollback, { type: "BEGIN_ROLLBACK" });
    expect(rollingBack.change?.status).toBe("ROLLING_BACK");
    expect(apply(rollingBack, { type: "ROLLBACK_SUCCEEDED" }).change?.status).toBe("ROLLED_BACK");

    const retryPath = apply(approvedRollback, { type: "BEGIN_ROLLBACK" });
    expect(apply(retryPath, { type: "ROLLBACK_FAILED" }).change?.status).toBe("ROLLBACK_FAILED");
  });

  it("rejects direct execution before approval, while awaiting approval, and after rejection or expiry", () => {
    const proposed = apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal });
    expectDenied(proposed, { type: "BEGIN_EXECUTION" });

    const awaiting = awaitingApproval();
    expectDenied(awaiting, { type: "BEGIN_EXECUTION" });
    expectDenied(apply(awaiting, { type: "HUMAN_REJECT" }), { type: "BEGIN_EXECUTION" });
    expectDenied(apply(awaiting, { type: "EXPIRE_PROPOSAL" }), { type: "BEGIN_EXECUTION" });
  });

  it("does not give an agent an approval transition", () => {
    const proposed = apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal });
    const afterAgentRequest = apply(proposed, { type: "REQUEST_HUMAN_APPROVAL", actor: "AGENT" });

    expect(afterAgentRequest.change?.status).toBe("AWAITING_HUMAN_APPROVAL");
    expect(afterAgentRequest.audit.every(({ actor, type }) => actor !== "AGENT" || type !== "HUMAN_APPROVE")).toBe(true);
  });

  it("binds approval to the exact trusted proposal and changes digest for every material field", () => {
    const baseDigest = computeProposalDigest(proposal);
    const alternatives = [
      { ...proposal, target: "database" },
      { ...proposal, action: "RECONFIGURE_SIMULATED_GATEWAY" },
      { ...proposal, parameters: { mode: "safe", retryLimit: 2 } },
      { ...proposal, preconditions: ["database is HEALTHY"] },
    ] as const;

    expect(computeProposalDigest(proposal)).toBe(baseDigest);
    for (const alternative of alternatives) {
      expect(computeProposalDigest(alternative)).not.toBe(baseDigest);
    }

    const approved = apply(awaitingApproval(), { type: "HUMAN_APPROVE", approvalId: "approval-a" });
    expect(approved.change).toMatchObject({
      status: "APPROVED",
      proposal: { proposalDigest: baseDigest },
      approval: { proposalDigest: baseDigest, issuedBy: "HUMAN", status: "ACTIVE" },
    });
    if (approved.change?.status !== "APPROVED") throw new Error("Expected approved change.");
    expect(
      isApprovalBoundToProposal(
        approved.change.approval,
        createImmutableProposal({ ...proposal, proposalId: "proposal-b" }),
      ),
    ).toBe(false);
    expect(
      isApprovalBoundToProposal({ ...approved.change.approval, status: "CONSUMED" }, approved.change.proposal),
    ).toBe(false);
    expectDenied(approved, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: { ...proposal, proposalId: "proposal-b" } });
  });

  it("consumes approval, rejects replay, and invalidates all authority on reset", () => {
    const active = apply(awaitingApproval(), { type: "HUMAN_APPROVE", approvalId: "approval-1" });
    const inFlight = apply(active, { type: "BEGIN_EXECUTION" });
    expectDenied(inFlight, { type: "BEGIN_EXECUTION" });

    const terminal = apply(apply(inFlight, { type: "EXECUTION_SUCCEEDED" }), { type: "VERIFICATION_SUCCEEDED" });
    const reset = apply(terminal, { type: "RESET_SCENARIO" });
    expect(reset.change).toBeNull();
    expectDenied(reset, { type: "BEGIN_EXECUTION" });
  });

  it("resets exactly and deterministically without mutating the canonical fixture", () => {
    const resetFromProposal = apply(
      apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal }),
      { type: "RESET_SCENARIO" },
    );
    const resetAgain = apply(resetFromProposal, { type: "RESET_SCENARIO" });

    expect(resetFromProposal).toEqual(resetAgain);
    expect(resetFromProposal.environment.services).toEqual(CANONICAL_SCENARIO.services);
    expect(CANONICAL_SCENARIO.services).toEqual([
      { id: "web-server", displayName: "Web Server", health: "HEALTHY" },
      { id: "database", displayName: "Database", health: "HEALTHY" },
      { id: "agent-gateway", displayName: "Agent Gateway", health: "DEGRADED" },
      { id: "knowledge-store", displayName: "Knowledge Store", health: "HEALTHY" },
    ]);
    expect(resetFromProposal.audit).toEqual([
      { sequence: 1, actor: "SYSTEM", type: "SCENARIO_RESET", lifecycle: "NONE" },
    ]);
  });

  it("rejects reset during active execution, verification, and rollback", () => {
    const inExecution = executing();
    expectDenied(inExecution, { type: "RESET_SCENARIO" });

    const verifying = apply(inExecution, { type: "EXECUTION_SUCCEEDED" });
    expectDenied(verifying, { type: "RESET_SCENARIO" });

    const awaitingRollback = apply(failed(), { type: "REQUEST_ROLLBACK_APPROVAL", actor: "AGENT" });
    const rollbackApproved = apply(awaitingRollback, { type: "HUMAN_APPROVE_ROLLBACK", approvalId: "rollback-1" });
    const rollingBack = apply(rollbackApproved, { type: "BEGIN_ROLLBACK" });
    expectDenied(rollingBack, { type: "RESET_SCENARIO" });
  });

  it("records deterministic HUMAN, AGENT, and SYSTEM audit events", () => {
    const state = apply(
      apply(
        apply(awaitingApproval(), { type: "HUMAN_APPROVE", approvalId: "approval-1" }),
        { type: "BEGIN_EXECUTION" },
      ),
      { type: "EXECUTION_SUCCEEDED" },
    );

    expect(state.audit.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(state.audit.map(({ actor }) => actor))).toEqual(new Set(["AGENT", "HUMAN", "SYSTEM"]));
  });

  it("explicitly rejects unsupported lifecycle progressions", () => {
    expectDenied(createInitialState(), { type: "VERIFICATION_SUCCEEDED" });
    expectDenied(failed(), { type: "VERIFICATION_SUCCEEDED" });
  });
});
