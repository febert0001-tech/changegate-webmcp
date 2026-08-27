import { describe, expect, it } from "vitest";

import type { HumanApproval, ImmutableChangeProposal, JsonObject, JsonValue } from "./change/contracts";
import { computeProposalDigest, createImmutableProposal } from "./change/proposal-digest";
import {
  createInitialState,
  isApprovalBoundToProposal,
  reduceChangeGate,
  type ChangeGateState,
  type DomainAction,
  type EnvironmentState,
} from "./engine";
import { CANONICAL_SCENARIO } from "./scenario/canonical-scenario";

const proposalInput = {
  proposalId: "proposal-agent-gateway-restart",
  target: "agent-gateway",
  action: "RESTART_SIMULATED_GATEWAY",
  parameters: { mode: "safe", nested: { retry: [1, 2] } },
  preconditions: ["agent-gateway is DEGRADED"],
} as const;

const proposalDigest = computeProposalDigest(proposalInput);

function humanApprove(approvalId: string, reviewInstanceId = "human-review:1"): DomainAction {
  return {
    type: "HUMAN_APPROVE",
    proposalId: proposalInput.proposalId,
    proposalDigest,
    reviewInstanceId,
    approvalId,
  };
}

function humanReject(reviewInstanceId = "human-review:1"): DomainAction {
  return {
    type: "HUMAN_REJECT",
    proposalId: proposalInput.proposalId,
    proposalDigest,
    reviewInstanceId,
  };
}

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  if (!result.ok) throw new Error(`Unexpected transition failure: ${result.error.action}`);
  return result.state;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function denied(state: ChangeGateState, action: DomainAction): void {
  const result = reduceChangeGate(state, action);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected transition denial.");
  expect(result.error.code).toBe("ILLEGAL_TRANSITION");
}

function proposed(): ChangeGateState {
  return apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: proposalInput });
}

function awaiting(): ChangeGateState {
  return apply(proposed(), {
    type: "REQUEST_HUMAN_APPROVAL",
    actor: "AGENT",
    proposalId: proposalInput.proposalId,
  });
}

function approved(): ChangeGateState {
  return apply(awaiting(), humanApprove("approval-1"));
}

function executing(): ChangeGateState {
  return apply(approved(), { type: "BEGIN_EXECUTION" });
}

function verifying(): ChangeGateState {
  return apply(executing(), { type: "EXECUTION_SUCCEEDED" });
}

function failed(): ChangeGateState {
  return apply(executing(), { type: "EXECUTION_FAILED" });
}

function rollbackAwaiting(withApproval = false): ChangeGateState {
  const state = apply(failed(), { type: "REQUEST_ROLLBACK_APPROVAL", actor: "AGENT" });
  return withApproval
    ? apply(state, { type: "HUMAN_APPROVE_ROLLBACK", approvalId: "rollback-approval-1" })
    : state;
}

function rollingBack(): ChangeGateState {
  return apply(rollbackAwaiting(true), { type: "BEGIN_ROLLBACK" });
}

function environmentWithGatewayHealthy(environment: EnvironmentState): EnvironmentState {
  return Object.freeze({
    services: Object.freeze(
      environment.services.map((service) =>
        Object.freeze(
          service.id === "agent-gateway" ? { ...service, health: "HEALTHY" as const } : { ...service },
        ),
      ),
    ),
  });
}

function expectCanonicalReset(state: ChangeGateState): void {
  const reset = apply(state, { type: "RESET_SCENARIO" });
  expect(reset.environment.services).toEqual(CANONICAL_SCENARIO.services);
  expect(reset.change).toBeNull();
  expect(reset.audit).toEqual([
    { sequence: 1, actor: "SYSTEM", type: "SCENARIO_RESET", lifecycle: "NONE" },
  ]);
  expect(reset.nextSequence).toBe(2);
}

describe("Gate 1.1 original rollback snapshot", () => {
  it("captures once and preserves the identical snapshot through execution failure and rollback", () => {
    const inExecution = executing();
    if (inExecution.change?.status !== "EXECUTING") throw new Error("Expected EXECUTING.");
    const originalSnapshot = inExecution.change.preChangeSnapshot;
    const changedEnvironment = environmentWithGatewayHealthy(inExecution.environment);
    const afterEffect = { ...inExecution, environment: changedEnvironment };

    const failedState = apply(afterEffect, { type: "EXECUTION_FAILED" });
    if (failedState.change?.status !== "FAILED") throw new Error("Expected FAILED.");
    expect(failedState.change.preChangeSnapshot).toBe(originalSnapshot);

    const awaitingRollback = apply(failedState, { type: "REQUEST_ROLLBACK_APPROVAL", actor: "AGENT" });
    if (awaitingRollback.change?.status !== "ROLLBACK_AWAITING_APPROVAL") throw new Error("Expected rollback approval.");
    expect(awaitingRollback.change.preChangeSnapshot).toBe(originalSnapshot);

    const rollbackApproved = apply(awaitingRollback, {
      type: "HUMAN_APPROVE_ROLLBACK",
      approvalId: "rollback-approval-1",
    });
    const rolling = apply({ ...rollbackApproved, environment: changedEnvironment }, { type: "BEGIN_ROLLBACK" });
    if (rolling.change?.status !== "ROLLING_BACK") throw new Error("Expected ROLLING_BACK.");
    expect(rolling.change.preChangeSnapshot).toBe(originalSnapshot);
    expect(rolling.change.preChangeSnapshot).not.toBe(changedEnvironment);

    const restored = apply(rolling, { type: "ROLLBACK_SUCCEEDED" });
    expect(restored.environment).toBe(originalSnapshot);
    expect(restored.environment.services).toEqual(CANONICAL_SCENARIO.services);
  });

  it("preserves the original snapshot through verification failure", () => {
    const inVerification = verifying();
    if (inVerification.change?.status !== "VERIFYING") throw new Error("Expected VERIFYING.");
    const originalSnapshot = inVerification.change.preChangeSnapshot;
    const changed = { ...inVerification, environment: environmentWithGatewayHealthy(inVerification.environment) };
    const failedState = apply(changed, { type: "VERIFICATION_FAILED" });

    if (failedState.change?.status !== "FAILED") throw new Error("Expected FAILED.");
    expect(failedState.change.preChangeSnapshot).toBe(originalSnapshot);
  });

  it("does not claim restoration after rollback failure", () => {
    const rolling = rollingBack();
    const changedEnvironment = environmentWithGatewayHealthy(rolling.environment);
    const result = apply({ ...rolling, environment: changedEnvironment }, { type: "ROLLBACK_FAILED" });

    expect(result.environment).toBe(changedEnvironment);
    expect(result.environment).not.toEqual(CANONICAL_SCENARIO);
  });
});

describe("Gate 1.1 reset legality and revocation", () => {
  const legalResetStates: readonly [string, () => ChangeGateState][] = [
    ["NONE", createInitialState],
    ["PROPOSED", proposed],
    ["AWAITING_HUMAN_APPROVAL", awaiting],
    ["APPROVED", approved],
    ["REJECTED", () => apply(awaiting(), humanReject())],
    ["EXPIRED", () => apply(awaiting(), { type: "EXPIRE_PROPOSAL" })],
    ["FAILED", failed],
    ["ROLLBACK_AWAITING_APPROVAL", () => rollbackAwaiting(true)],
    ["SUCCEEDED", () => apply(verifying(), { type: "VERIFICATION_SUCCEEDED" })],
    ["ROLLED_BACK", () => apply(rollingBack(), { type: "ROLLBACK_SUCCEEDED" })],
    ["ROLLBACK_FAILED", () => apply(rollingBack(), { type: "ROLLBACK_FAILED" })],
  ];

  it.each(legalResetStates)("allows reset from %s and clears all transient authority", (_name, makeState) => {
    expectCanonicalReset(makeState());
  });

  it.each([
    ["EXECUTING", executing],
    ["VERIFYING", verifying],
    ["ROLLING_BACK", rollingBack],
  ] as const)("rejects reset from active %s", (_name, makeState) => {
    denied(makeState(), { type: "RESET_SCENARIO" });
  });

  it("makes pre-reset execution and rollback approvals unusable", () => {
    const resetExecutionApproval = apply(approved(), { type: "RESET_SCENARIO" });
    denied(resetExecutionApproval, { type: "BEGIN_EXECUTION" });

    const resetRollbackApproval = apply(rollbackAwaiting(true), { type: "RESET_SCENARIO" });
    denied(resetRollbackApproval, { type: "BEGIN_ROLLBACK" });
  });
});

describe("Gate 1.1 deep proposal and approval immutability", () => {
  it("owns and freezes all nested proposal values", () => {
    const leaf = { delay: 2 };
    const retries: unknown[] = [1, leaf];
    const callerParameters = { config: { retries } };
    const immutable = createImmutableProposal({ ...proposalInput, parameters: callerParameters });

    leaf.delay = 99;
    retries.push("caller mutation");
    callerParameters.config = { retries: ["replacement"] };

    expect(immutable.parameters).toEqual({ config: { retries: [1, { delay: 2 }] } });
    const config = immutable.parameters.config;
    if (!isJsonObject(config)) throw new Error("Expected config object.");
    const ownedRetries = config.retries;
    expect(Object.isFrozen(immutable)).toBe(true);
    expect(Object.isFrozen(immutable.parameters)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(ownedRetries)).toBe(true);
    expect(Object.isFrozen(immutable.preconditions)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => true],
    ["symbol", Symbol("unsupported")],
    ["bigint", BigInt(1)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date(0)],
    ["Map", new Map<string, string>()],
    ["Set", new Set<string>()],
    ["class instance", new (class Unsupported {})()],
  ])("rejects unsupported %s values", (_name, unsupported) => {
    expect(() =>
      createImmutableProposal({ ...proposalInput, parameters: { unsupported } }),
    ).toThrow(TypeError);
  });

  it("rejects cyclic structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createImmutableProposal({ ...proposalInput, parameters: cyclic })).toThrow(TypeError);
  });

  it("rejects non-JSON container shapes and accessor-backed values", () => {
    const sparse = new Array(1);
    const symbolKeyed = { safe: true, [Symbol("hidden")]: "not canonical" };
    const accessorBacked = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "dynamic",
    });
    const arraySubclass = new (class UnsupportedArray extends Array<number> {})(1, 2);

    for (const unsupported of [sparse, symbolKeyed, accessorBacked, arraySubclass]) {
      expect(() =>
        createImmutableProposal({ ...proposalInput, parameters: { unsupported } }),
      ).toThrow(TypeError);
    }
  });

  it("canonicalizes object keys while preserving array order and nested material changes", () => {
    const first = { outer: { alpha: 1, beta: 2 }, list: [1, 2] };
    const reordered = { list: [1, 2], outer: { beta: 2, alpha: 1 } };
    const nestedChange = { outer: { beta: 3, alpha: 1 }, list: [1, 2] };
    const arrayChange = { outer: { alpha: 1, beta: 2 }, list: [2, 1] };

    const firstDigest = computeProposalDigest({ ...proposalInput, parameters: first });
    expect(computeProposalDigest({ ...proposalInput, parameters: reordered })).toBe(firstDigest);
    expect(computeProposalDigest({ ...proposalInput, parameters: nestedChange })).not.toBe(firstDigest);
    expect(computeProposalDigest({ ...proposalInput, parameters: arrayChange })).not.toBe(firstDigest);
    expect(computeProposalDigest({ ...proposalInput, parameters: first })).toBe(firstDigest);
  });

  it("uses canonical content for approval binding and rejects stale or consumed authority", () => {
    const proposal = createImmutableProposal({
      ...proposalInput,
      parameters: { first: 1, second: { alpha: 2, beta: 3 } },
    });
    const reorderedParameters = Object.freeze({
      second: Object.freeze({ beta: 3, alpha: 2 }),
      first: 1,
    }) satisfies JsonObject;
    const approval = Object.freeze({
      approvalId: "approval-canonical",
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      target: proposal.target,
      action: proposal.action,
      parameters: reorderedParameters,
      preconditions: proposal.preconditions,
      issuedBy: "HUMAN",
      status: "ACTIVE",
    }) satisfies HumanApproval;

    expect(isApprovalBoundToProposal(approval, proposal)).toBe(true);
    expect(isApprovalBoundToProposal({ ...approval, status: "CONSUMED" }, proposal)).toBe(false);

    const changed = createImmutableProposal({
      ...proposalInput,
      parameters: { first: 1, second: { alpha: 2, beta: 4 } },
    });
    expect(isApprovalBoundToProposal(approval, changed)).toBe(false);

    const staleDigestProposal = Object.freeze({
      ...changed,
      proposalDigest: proposal.proposalDigest,
    }) satisfies ImmutableChangeProposal;
    expect(isApprovalBoundToProposal(approval, staleDigestProposal)).toBe(false);
  });

  it("prevents runtime tampering with authoritative proposal and approval structures", () => {
    const state = approved();
    if (state.change?.status !== "APPROVED") throw new Error("Expected APPROVED.");
    const authoritativeProposal = state.change.proposal;
    const authoritativeApproval = state.change.approval;

    expect(Reflect.set(authoritativeProposal, "action", "TAMPERED")).toBe(false);
    expect(Reflect.set(authoritativeProposal.parameters, "mode", "dangerous")).toBe(false);
    expect(Reflect.set(authoritativeApproval, "proposalDigest", "forged")).toBe(false);
    expect(isApprovalBoundToProposal(authoritativeApproval, authoritativeProposal)).toBe(true);
  });
});
