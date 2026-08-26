import { describe, expect, it } from "vitest";

import {
  createChangeGateOperations,
  FLAGSHIP_ACTION,
  FLAGSHIP_PRECONDITION,
  FLAGSHIP_TARGET,
  type ChangeGateOperations,
  type EnvironmentStatusProjection,
} from "../src/application/changegate-operations";
import type { WebMcpToolDefinition } from "../src/webmcp/native-contract";
import {
  createGate2ToolDefinitions,
  GATE_2_TOOL_NAMES,
  type Gate2ToolName,
  type Gate2ToolResult,
} from "../src/webmcp/tool-catalog";

const validProposal = {
  proposalId: "proposal-agent-gateway-restart",
  target: FLAGSHIP_TARGET,
  action: FLAGSHIP_ACTION,
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: [FLAGSHIP_PRECONDITION],
} as const;

function findTool(
  definitions: readonly WebMcpToolDefinition[],
  name: Gate2ToolName,
): WebMcpToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`Missing tool definition: ${name}`);
  return definition;
}

async function invoke(
  definition: WebMcpToolDefinition,
  input: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<Gate2ToolResult> {
  return (await definition.execute(input, { signal })) as Gate2ToolResult;
}

describe("Gate 2 WebMCP tool catalog", () => {
  it("defines exactly the seven allowed tools and strict JSON schemas", () => {
    const definitions = createGate2ToolDefinitions(createChangeGateOperations());

    expect(definitions.map(({ name }) => name)).toEqual(GATE_2_TOOL_NAMES);
    expect(new Set(definitions.map(({ name }) => name)).size).toBe(7);
    expect(definitions.map(({ name }) => name)).not.toContain("approve_change");
    expect(definitions.map(({ name }) => name)).not.toContain("execute_approved_change");
    expect(definitions.map(({ name }) => name)).not.toContain("request_rollback");
    for (const definition of definitions) {
      expect(definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("validates and submits the one supported proposal with AGENT authority only", async () => {
    const operations = createChangeGateOperations();
    const definitions = createGate2ToolDefinitions(operations);
    const proposed = await invoke(findTool(definitions, "propose_change"), validProposal);

    expect(proposed).toMatchObject({
      status: "SUCCESS",
      data: {
        lifecycle: "PROPOSED",
        proposalId: validProposal.proposalId,
        target: FLAGSHIP_TARGET,
        action: FLAGSHIP_ACTION,
      },
    });
    expect(operations.getAuditTrail().events).toEqual([
      {
        sequence: 1,
        actor: "AGENT",
        type: "PROPOSE_CHANGE",
        lifecycle: "PROPOSED",
      },
    ]);
  });

  it.each([
    ["null", null],
    ["array", []],
    [
      "missing field",
      {
        proposalId: validProposal.proposalId,
        target: validProposal.target,
        parameters: validProposal.parameters,
        preconditions: validProposal.preconditions,
      },
    ],
    ["unknown service", { ...validProposal, target: "unknown-service" }],
    ["unsupported action", { ...validProposal, action: "DELETE_GATEWAY" }],
    ["caller digest", { ...validProposal, proposalDigest: "caller-controlled" }],
    ["caller actor", { ...validProposal, actor: "HUMAN" }],
    ["caller issuer", { ...validProposal, issuedBy: "HUMAN" }],
    ["approval object", { ...validProposal, approval: { issuedBy: "HUMAN" } }],
    ["approval ID", { ...validProposal, approvalId: "approval-1" }],
    ["authorization", { ...validProposal, authorization: true }],
    ["unrecognized command", { ...validProposal, command: "run" }],
    [
      "extra parameter",
      { ...validProposal, parameters: { ...validProposal.parameters, force: true } },
    ],
    ["invalid retry bound", { ...validProposal, parameters: { mode: "safe", retryLimit: 99 } }],
  ])("rejects %s without reaching the reducer", async (_name, input) => {
    const operations = createChangeGateOperations();
    const result = await invoke(
      findTool(createGate2ToolDefinitions(operations), "propose_change"),
      input,
    );

    expect(result).toEqual({
      status: "INVALID_INPUT",
      reason: "INPUT_VALIDATION_FAILED",
    });
    expect(operations.getChangeProposal()).toBeNull();
    expect(operations.getAuditTrail().events).toEqual([]);
  });

  it("rejects hostile nested runtime values before Zod or domain trust", async () => {
    class ParameterClass {
      readonly mode = "safe";
      readonly retryLimit = 1;
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessorParameters = Object.defineProperties({}, {
      mode: { enumerable: true, value: "safe" },
      retryLimit: { enumerable: true, get: () => 1 },
    });
    const hostileParameters: readonly unknown[] = [
      { mode: "safe", retryLimit: undefined },
      { mode: "safe", retryLimit: () => 1 },
      { mode: "safe", retryLimit: Symbol("invalid") },
      { mode: "safe", retryLimit: BigInt(1) },
      { mode: "safe", retryLimit: Number.NaN },
      { mode: "safe", retryLimit: Number.POSITIVE_INFINITY },
      new Date(0),
      new Map<string, string>(),
      new Set<string>(),
      new ParameterClass(),
      cyclic,
      accessorParameters,
    ];

    for (const parameters of hostileParameters) {
      const operations = createChangeGateOperations();
      const result = await invoke(
        findTool(createGate2ToolDefinitions(operations), "propose_change"),
        { ...validProposal, parameters },
      );
      expect(result.status).toBe("INVALID_INPUT");
      expect(operations.getChangeProposal()).toBeNull();
    }
  });

  it("requires an exact proposal ID and never creates human approval", async () => {
    const operations = createChangeGateOperations();
    const definitions = createGate2ToolDefinitions(operations);
    await invoke(findTool(definitions, "propose_change"), validProposal);

    const request = findTool(definitions, "request_change_approval");
    expect(await invoke(request, { proposalId: "wrong-proposal" })).toMatchObject({
      status: "DENIED",
      lifecycle: "PROPOSED",
    });
    expect(
      await invoke(request, { proposalId: validProposal.proposalId, actor: "HUMAN" }),
    ).toEqual({ status: "INVALID_INPUT", reason: "INPUT_VALIDATION_FAILED" });
    expect(
      await invoke(request, {
        proposalId: validProposal.proposalId,
        approvalId: "caller-approval",
        approval: { issuedBy: "HUMAN" },
      }),
    ).toEqual({ status: "INVALID_INPUT", reason: "INPUT_VALIDATION_FAILED" });

    const accepted = await invoke(request, { proposalId: validProposal.proposalId });
    expect(accepted).toMatchObject({
      status: "SUCCESS",
      data: { lifecycle: "AWAITING_HUMAN_APPROVAL" },
    });
    const proposal = operations.getChangeProposal();
    expect(proposal?.lifecycle).toBe("AWAITING_HUMAN_APPROVAL");
    expect(proposal === null ? true : "approval" in proposal).toBe(false);
    expect(operations.getAuditTrail().events.some(({ actor }) => actor === "HUMAN")).toBe(false);
  });

  it("returns safe read results without mutating or aliasing operations state", async () => {
    const operations = createChangeGateOperations();
    const definitions = createGate2ToolDefinitions(operations);
    const auditBefore = operations.getAuditTrail();

    for (const name of [
      "get_environment_status",
      "get_change_policy",
      "get_change_proposal",
      "get_audit_trail",
    ] as const) {
      const result = await invoke(findTool(definitions, name), {});
      expect(["SUCCESS", "NO_ACTIVE_PROPOSAL"]).toContain(result.status);
    }
    expect(await invoke(findTool(definitions, "get_service_details"), {
      serviceId: "unknown-service",
    })).toEqual({ status: "INVALID_INPUT", reason: "INPUT_VALIDATION_FAILED" });

    const environmentResult = await invoke(findTool(definitions, "get_environment_status"), {});
    if (environmentResult.status !== "SUCCESS") throw new Error("Expected environment result.");
    const environment = environmentResult.data as EnvironmentStatusProjection;
    expect(Reflect.set(environment.services[2]!, "health", "HEALTHY")).toBe(false);
    expect(operations.getEnvironmentStatus().services[2]?.health).toBe("DEGRADED");
    expect(operations.getAuditTrail()).toEqual(auditBefore);
  });

  it("honors invocation cancellation without confusing it with authorization", async () => {
    const operations = createChangeGateOperations();
    const proposalTool = findTool(createGate2ToolDefinitions(operations), "propose_change");
    const invocation = new AbortController();
    invocation.abort();

    expect(await invoke(proposalTool, validProposal, invocation.signal)).toEqual({
      status: "CANCELLED",
    });
    expect(operations.getChangeProposal()).toBeNull();
  });

  it("contains unexpected handler failures without leaking Error details", async () => {
    const base = createChangeGateOperations();
    const throwingOperations: ChangeGateOperations = Object.freeze({
      ...base,
      proposeChange: () => {
        throw new Error("sensitive internal failure");
      },
    });
    const result = await invoke(
      findTool(createGate2ToolDefinitions(throwingOperations), "propose_change"),
      validProposal,
    );

    expect(result).toEqual({ status: "DENIED", reason: "OPERATION_NOT_COMPLETED" });
    expect(JSON.stringify(result)).not.toContain("sensitive internal failure");
    expect(JSON.stringify(result)).not.toContain("stack");
  });
});
