import { describe, expect, it, vi } from "vitest";

import {
  createChangeGateOperations,
  createWebMcpOperationsFacade,
  FLAGSHIP_ACTION,
  FLAGSHIP_PRECONDITION,
  FLAGSHIP_TARGET,
} from "../src/application/changegate-operations";
import { computeProposalDigest } from "../src/domain/change/proposal-digest";
import {
  createInitialState,
  reduceChangeGate,
  type ChangeGateState,
  type DomainAction,
} from "../src/domain/engine";
import { createGate2ToolDefinitions } from "../src/webmcp/tool-catalog";

const EXPECTED_WEBMCP_TOOL_NAMES = [
  "get_environment_status",
  "get_service_details",
  "get_change_policy",
  "get_change_proposal",
  "get_audit_trail",
  "propose_change",
  "request_change_approval",
] as const;

const proposalA = {
  proposalId: "proposal-agent-gateway-restart",
  target: FLAGSHIP_TARGET,
  action: FLAGSHIP_ACTION,
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: [FLAGSHIP_PRECONDITION],
} as const;

const proposalBWithReusedId = {
  ...proposalA,
  parameters: { mode: "safe", retryLimit: 2 },
} as const;

function apply(state: ChangeGateState, action: DomainAction): ChangeGateState {
  const result = reduceChangeGate(state, action);
  if (!result.ok) throw new Error(`Unexpected denial: ${result.error.action}`);
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

function awaiting(
  proposal: typeof proposalA | typeof proposalBWithReusedId = proposalA,
): ChangeGateState {
  return apply(
    apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal }),
    {
      type: "REQUEST_HUMAN_APPROVAL",
      actor: "AGENT",
      proposalId: proposal.proposalId,
    },
  );
}

function approveAction(
  proposal: typeof proposalA | typeof proposalBWithReusedId,
  approvalId = "human-test-approval",
  reviewInstanceId = "human-review:1",
): DomainAction {
  return {
    type: "HUMAN_APPROVE",
    proposalId: proposal.proposalId,
    proposalDigest: computeProposalDigest(proposal),
    reviewInstanceId,
    approvalId,
  };
}

function rejectAction(
  proposal: typeof proposalA | typeof proposalBWithReusedId,
  reviewInstanceId = "human-review:1",
): DomainAction {
  return {
    type: "HUMAN_REJECT",
    proposalId: proposal.proposalId,
    proposalDigest: computeProposalDigest(proposal),
    reviewInstanceId,
  };
}

describe("Gate 3 exact human authorization", () => {
  it("allows zero-argument human operations to approve or reject only the trusted pending proposal", () => {
    const approvedOperations = createChangeGateOperations();
    expect(approvedOperations.approvePendingChange).toHaveLength(0);
    expect(approvedOperations.rejectPendingChange).toHaveLength(0);
    approvedOperations.proposeChange(proposalA);
    approvedOperations.requestChangeApproval(proposalA.proposalId);
    const pendingApproval = approvedOperations.getChangeProposal();
    if (pendingApproval === null) throw new Error("Expected pending proposal.");

    expect(approvedOperations.approvePendingChange()).toMatchObject({
      status: "SUCCESS",
      proposal: { lifecycle: "APPROVED" },
    });
    expect(approvedOperations.getChangeProposal()).toMatchObject({ lifecycle: "APPROVED" });
    expect(approvedOperations.getAuditTrail().events.map(({ actor }) => actor)).toEqual([
      "AGENT",
      "AGENT",
      "HUMAN",
    ]);
    expect(approvedOperations.getChangeProposal()).not.toHaveProperty("approval");
    expect(approvedOperations.getEnvironmentStatus().services[2]?.health).toBe("DEGRADED");

    const rejectedOperations = createChangeGateOperations();
    rejectedOperations.proposeChange(proposalA);
    rejectedOperations.requestChangeApproval(proposalA.proposalId);
    const pendingRejection = rejectedOperations.getChangeProposal();
    if (pendingRejection === null) throw new Error("Expected pending proposal.");

    expect(rejectedOperations.rejectPendingChange()).toMatchObject({
      status: "SUCCESS",
      proposal: { lifecycle: "REJECTED" },
    });
    expect(rejectedOperations.getChangeProposal()).not.toHaveProperty("approval");
    expect(rejectedOperations.getAuditTrail().events.at(-1)).toMatchObject({
      actor: "HUMAN",
      type: "HUMAN_REJECT",
      lifecycle: "REJECTED",
    });
  });

  it("leaves state, audit, revision, and subscribers unchanged on a repeated decision", () => {
    const operations = createChangeGateOperations();
    const listener = vi.fn();
    const unsubscribe = operations.subscribe(listener);
    operations.subscribe(() => {
      throw new Error("subscriber failure must stay isolated");
    });

    expect(operations.proposeChange(proposalA).status).toBe("SUCCESS");
    expect(operations.requestChangeApproval(proposalA.proposalId).status).toBe("SUCCESS");
    expect(listener).toHaveBeenCalledTimes(2);

    expect(operations.approvePendingChange().status).toBe("SUCCESS");
    expect(listener).toHaveBeenCalledTimes(3);

    const before = operations.getChangeProposal();
    const auditBefore = operations.getAuditTrail();
    const revisionBefore = operations.getRevision();
    if (before === null) throw new Error("Expected pending proposal.");

    expect(operations.approvePendingChange()).toEqual({
      status: "DENIED",
      lifecycle: "APPROVED",
      reason: "TRANSITION_NOT_PERMITTED",
    });
    expect(operations.getChangeProposal()).toEqual(before);
    expect(operations.getAuditTrail()).toEqual(auditBefore);
    expect(operations.getRevision()).toBe(revisionBefore);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(operations.rejectPendingChange().status).toBe("DENIED");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("denies repeated rejection without changing proposal, audit, revision, or subscribers", () => {
    const operations = createChangeGateOperations();
    const listener = vi.fn();
    operations.subscribe(listener);
    operations.proposeChange(proposalA);
    operations.requestChangeApproval(proposalA.proposalId);
    expect(operations.rejectPendingChange().status).toBe("SUCCESS");

    const proposalBefore = operations.getChangeProposal();
    const auditBefore = operations.getAuditTrail();
    const revisionBefore = operations.getRevision();
    expect(operations.rejectPendingChange()).toEqual({
      status: "DENIED",
      lifecycle: "REJECTED",
      reason: "TRANSITION_NOT_PERMITTED",
    });
    expect(operations.approvePendingChange().status).toBe("DENIED");
    expect(operations.getChangeProposal()).toEqual(proposalBefore);
    expect(operations.getAuditTrail()).toEqual(auditBefore);
    expect(operations.getRevision()).toBe(revisionBefore);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("rejects stale and invalid human decisions in the reducer", () => {
    const digestA = computeProposalDigest(proposalA);
    const pendingA = awaiting(proposalA);

    expectDenied(pendingA, {
      type: "HUMAN_APPROVE",
      proposalId: "wrong-proposal",
      proposalDigest: digestA,
      reviewInstanceId: "human-review:1",
      approvalId: "denied",
    });
    expectDenied(pendingA, {
      type: "HUMAN_REJECT",
      proposalId: "wrong-proposal",
      proposalDigest: digestA,
      reviewInstanceId: "human-review:1",
    });
    expectDenied(pendingA, {
      type: "HUMAN_APPROVE",
      proposalId: proposalA.proposalId,
      proposalDigest: "wrong-digest",
      reviewInstanceId: "human-review:1",
      approvalId: "denied",
    });
    expectDenied(pendingA, {
      type: "HUMAN_REJECT",
      proposalId: proposalA.proposalId,
      proposalDigest: "wrong-digest",
      reviewInstanceId: "human-review:1",
    });
    expectDenied(pendingA, {
      type: "HUMAN_APPROVE",
      proposalId: proposalA.proposalId,
      proposalDigest: digestA,
      reviewInstanceId: "human-review:wrong",
      approvalId: "denied",
    });
    expectDenied(pendingA, {
      type: "HUMAN_REJECT",
      proposalId: proposalA.proposalId,
      proposalDigest: digestA,
      reviewInstanceId: "human-review:wrong",
    });

    const reset = apply(pendingA, { type: "RESET_SCENARIO" });
    const pendingB = apply(
      apply(reset, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: proposalBWithReusedId }),
      {
        type: "REQUEST_HUMAN_APPROVAL",
        actor: "AGENT",
        proposalId: proposalBWithReusedId.proposalId,
      },
    );
    expect(computeProposalDigest(proposalBWithReusedId)).not.toBe(digestA);
    expectDenied(pendingB, approveAction(proposalA, "stale-approval"));
    expectDenied(pendingB, rejectAction(proposalA));

    const rejected = apply(pendingA, rejectAction(proposalA));
    expectDenied(rejected, approveAction(proposalA));
    expectDenied(rejected, { type: "BEGIN_EXECUTION" });
    expect(rejected.change).not.toHaveProperty("approval");

    const approved = apply(pendingA, approveAction(proposalA));
    expectDenied(approved, rejectAction(proposalA));
    expectDenied(createInitialState(), approveAction(proposalA));
    expectDenied(
      apply(createInitialState(), { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: proposalA }),
      approveAction(proposalA),
    );
  });

  it("denies byte-identical decisions captured from an earlier lifecycle", () => {
    const firstReview = awaiting(proposalA);
    if (firstReview.change?.status !== "AWAITING_HUMAN_APPROVAL") {
      throw new Error("Expected first review.");
    }
    const staleApprove = approveAction(
      proposalA,
      "stale-approval",
      firstReview.change.reviewInstanceId,
    );
    const staleReject = rejectAction(proposalA, firstReview.change.reviewInstanceId);

    const reset = apply(firstReview, { type: "RESET_SCENARIO" });
    const secondReview = apply(
      apply(reset, { type: "PROPOSE_CHANGE", actor: "AGENT", proposal: proposalA }),
      {
        type: "REQUEST_HUMAN_APPROVAL",
        actor: "AGENT",
        proposalId: proposalA.proposalId,
      },
    );
    if (secondReview.change?.status !== "AWAITING_HUMAN_APPROVAL") {
      throw new Error("Expected second review.");
    }

    expect(secondReview.change.reviewInstanceId).not.toBe(firstReview.change.reviewInstanceId);
    expect(secondReview.change.proposal.proposalDigest).toBe(firstReview.change.proposal.proposalDigest);
    expectDenied(secondReview, staleApprove);
    expectDenied(secondReview, staleReject);
  });

  it.each(["APPROVED", "REJECTED"] as const)(
    "keeps registered WebMCP callbacks current after a human %s decision",
    async (outcome) => {
      const operations = createChangeGateOperations();
      const definitions = createGate2ToolDefinitions(createWebMcpOperationsFacade(operations));
      const proposalTool = definitions.find(({ name }) => name === "get_change_proposal");
      if (proposalTool === undefined) throw new Error("Expected proposal tool.");

      operations.proposeChange(proposalA);
      operations.requestChangeApproval(proposalA.proposalId);
      if (outcome === "APPROVED") operations.approvePendingChange();
      else operations.rejectPendingChange();

      await expect(
        proposalTool.execute({}, { signal: new AbortController().signal }),
      ).resolves.toMatchObject({
        status: "SUCCESS",
        data: { lifecycle: outcome },
      });
    },
  );

  it("keeps the WebMCP runtime facade query/proposal-only and the catalog at seven tools", () => {
    const operations = createChangeGateOperations();
    const facade = createWebMcpOperationsFacade(operations);
    const definitions = createGate2ToolDefinitions(facade);

    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade)).toEqual([
      "getEnvironmentStatus",
      "getServiceDetails",
      "getChangePolicy",
      "getChangeProposal",
      "getAuditTrail",
      "proposeChange",
      "requestChangeApproval",
    ]);
    expect(definitions.map(({ name }) => name)).toEqual(EXPECTED_WEBMCP_TOOL_NAMES);
    expect(definitions).toHaveLength(7);
    const registeredNames = definitions.map(({ name }) => name);
    for (const forbiddenName of [
      "approve_change",
      "reject_change",
      "execute_approved_change",
      "verify_change",
      "rollback_change",
    ]) {
      expect(registeredNames).not.toContain(forbiddenName);
    }
    expect(Object.keys(operations).join(" ")).not.toMatch(/execut|verif|rollback/iu);
  });
});
