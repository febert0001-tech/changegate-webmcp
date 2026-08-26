import { describe, expect, it } from "vitest";

import {
  createChangeGateOperations,
  FLAGSHIP_ACTION,
  FLAGSHIP_PRECONDITION,
  FLAGSHIP_TARGET,
} from "../src/application/changegate-operations";

const flagshipInput = {
  proposalId: "proposal-agent-gateway-restart",
  target: FLAGSHIP_TARGET,
  action: FLAGSHIP_ACTION,
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: [FLAGSHIP_PRECONDITION],
} as const;

describe("Gate 2 domain operations", () => {
  it("returns bounded service and policy projections without changing state", () => {
    const operations = createChangeGateOperations();
    const beforeAudit = operations.getAuditTrail();
    const environment = operations.getEnvironmentStatus();
    const service = operations.getServiceDetails("agent-gateway");
    const policy = operations.getChangePolicy();

    expect(environment.services).toHaveLength(4);
    expect(environment.services.map(({ id }) => id)).toEqual([
      "web-server",
      "database",
      "agent-gateway",
      "knowledge-store",
    ]);
    expect(service).toEqual({
      id: "agent-gateway",
      displayName: "Agent Gateway",
      health: "DEGRADED",
    });
    expect(service === null ? [] : Object.keys(service).sort()).toEqual([
      "displayName",
      "health",
      "id",
    ]);
    expect(policy).toEqual({
      consequentialChangesRequireVisibleHumanApproval: true,
      approvalBindsExactProposal: true,
      approvalIsSingleUse: true,
      rollbackRequiresSeparateHumanApproval: true,
    });
    expect(operations.getChangeProposal()).toBeNull();
    expect(operations.getAuditTrail()).toEqual(beforeAudit);
  });

  it("does not alias environment, proposal, or audit authority in query output", () => {
    const operations = createChangeGateOperations();
    const callerLeaf = { attempts: [1, 2] };
    const richerInput = {
      ...flagshipInput,
      parameters: {
        ...flagshipInput.parameters,
        diagnostics: callerLeaf,
      },
    } as const;

    expect(operations.proposeChange(richerInput).status).toBe("SUCCESS");
    callerLeaf.attempts.push(99);

    const environmentA = operations.getEnvironmentStatus();
    const proposalA = operations.getChangeProposal();
    const auditA = operations.getAuditTrail();
    if (proposalA === null) throw new Error("Expected a proposal projection.");

    expect(Reflect.set(environmentA.services[0]!, "health", "DEGRADED")).toBe(false);
    expect(Reflect.set(proposalA.parameters, "mode", "unsafe")).toBe(false);
    expect(Reflect.set(auditA.events[0]!, "actor", "HUMAN")).toBe(false);

    const environmentB = operations.getEnvironmentStatus();
    const proposalB = operations.getChangeProposal();
    const auditB = operations.getAuditTrail();
    if (proposalB === null) throw new Error("Expected a proposal projection.");

    expect(environmentB).not.toBe(environmentA);
    expect(environmentB.services).not.toBe(environmentA.services);
    expect(environmentB.services[0]).not.toBe(environmentA.services[0]);
    expect(proposalB).not.toBe(proposalA);
    expect(proposalB.parameters).not.toBe(proposalA.parameters);
    expect(proposalB.parameters).toEqual({
      diagnostics: { attempts: [1, 2] },
      mode: "safe",
      retryLimit: 1,
    });
    expect(auditB).not.toBe(auditA);
    expect(auditB.events).not.toBe(auditA.events);
    expect(auditB.events[0]).not.toBe(auditA.events[0]);
    expect(auditB.events[0]?.actor).toBe("AGENT");
  });

  it("requires the exact proposal ID and stops at human-review awaiting state", () => {
    const operations = createChangeGateOperations();
    expect(operations.proposeChange(flagshipInput).status).toBe("SUCCESS");

    const auditBeforeDenial = operations.getAuditTrail();
    expect(operations.requestChangeApproval("wrong-proposal")).toEqual({
      status: "DENIED",
      lifecycle: "PROPOSED",
      reason: "TRANSITION_NOT_PERMITTED",
    });
    expect(operations.getAuditTrail()).toEqual(auditBeforeDenial);

    const accepted = operations.requestChangeApproval(flagshipInput.proposalId);
    expect(accepted.status).toBe("SUCCESS");
    if (accepted.status !== "SUCCESS") throw new Error("Expected successful request.");
    expect(accepted.proposal.lifecycle).toBe("AWAITING_HUMAN_APPROVAL");
    expect(Object.keys(accepted.proposal).sort()).toEqual([
      "action",
      "lifecycle",
      "parameters",
      "preconditions",
      "proposalDigest",
      "proposalId",
      "target",
    ]);

    const audit = operations.getAuditTrail();
    expect(audit.events.at(-1)).toMatchObject({
      actor: "AGENT",
      type: "REQUEST_HUMAN_APPROVAL",
      lifecycle: "AWAITING_HUMAN_APPROVAL",
    });
    expect(audit.events.some(({ actor }) => actor === "HUMAN")).toBe(false);
  });

  it("keeps separate operations instances isolated", () => {
    const first = createChangeGateOperations();
    const second = createChangeGateOperations();

    expect(first.proposeChange(flagshipInput).status).toBe("SUCCESS");
    expect(first.getChangeProposal()?.lifecycle).toBe("PROPOSED");
    expect(second.getChangeProposal()).toBeNull();
    expect(second.getAuditTrail().events).toEqual([]);
  });
});
