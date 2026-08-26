import { describe, expect, it } from "vitest";

import {
  createChangeGateOperations,
  FLAGSHIP_ACTION,
  FLAGSHIP_PRECONDITION,
  FLAGSHIP_TARGET,
} from "../src/application/changegate-operations";
import {
  getWebMcpModelContext,
  type WebMcpModelContext,
  type WebMcpRegistrationOptions,
  type WebMcpToolDefinition,
} from "../src/webmcp/native-contract";
import { startWebMcpRegistration } from "../src/webmcp/registration";
import type { Gate2ToolResult } from "../src/webmcp/tool-catalog";

const validProposal = {
  proposalId: "proposal-agent-gateway-restart",
  target: FLAGSHIP_TARGET,
  action: FLAGSHIP_ACTION,
  parameters: { mode: "safe", retryLimit: 1 },
  preconditions: [FLAGSHIP_PRECONDITION],
} as const;

class FakeModelContext implements WebMcpModelContext {
  readonly calls: WebMcpToolDefinition[] = [];
  readonly registrationSignals: AbortSignal[] = [];
  readonly live = new Map<string, WebMcpToolDefinition>();

  constructor(
    private readonly failureCall?: number,
    private readonly pendingCall?: number,
  ) {}

  async registerTool(
    tool: WebMcpToolDefinition,
    options: WebMcpRegistrationOptions,
  ): Promise<void> {
    this.calls.push(tool);
    this.registrationSignals.push(options.signal);
    const callNumber = this.calls.length;
    if (callNumber === this.failureCall) throw new Error("simulated registration failure");

    this.live.set(tool.name, tool);
    options.signal.addEventListener("abort", () => this.live.delete(tool.name), { once: true });
    if (options.signal.aborted) this.live.delete(tool.name);

    if (callNumber === this.pendingCall && !options.signal.aborted) {
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

function registeredTool(context: FakeModelContext, name: string): WebMcpToolDefinition {
  const definition = context.live.get(name);
  if (definition === undefined) throw new Error(`Expected registered tool: ${name}`);
  return definition;
}

async function invoke(
  definition: WebMcpToolDefinition,
  input: unknown,
  signal: AbortSignal,
): Promise<Gate2ToolResult> {
  return (await definition.execute(input, { signal })) as Gate2ToolResult;
}

describe("Gate 2 WebMCP registration lifecycle", () => {
  it("registers exactly seven tools with one shared registration signal", async () => {
    const context = new FakeModelContext();
    const session = startWebMcpRegistration(context, createChangeGateOperations());

    expect(await session.ready).toEqual({ status: "REGISTERED", toolCount: 7 });
    expect(context.calls).toHaveLength(7);
    expect(context.live.size).toBe(7);
    expect(new Set(context.registrationSignals)).toEqual(
      new Set([session.registrationSignal]),
    );
    expect(session.registrationSignal.aborted).toBe(false);
  });

  it("aborts all registrations during cleanup and supports a clean remount", async () => {
    const context = new FakeModelContext();
    const first = startWebMcpRegistration(context, createChangeGateOperations());
    await first.ready;
    expect(context.live.size).toBe(7);

    first.dispose();
    expect(first.registrationSignal.aborted).toBe(true);
    expect(context.live.size).toBe(0);

    const second = startWebMcpRegistration(context, createChangeGateOperations());
    expect(await second.ready).toEqual({ status: "REGISTERED", toolCount: 7 });
    expect(context.live.size).toBe(7);
    expect(context.calls).toHaveLength(14);
    second.dispose();
    expect(context.live.size).toBe(0);
  });

  it("safely reports unsupported browsers without a model context", async () => {
    const supported = new FakeModelContext();
    expect(getWebMcpModelContext({ modelContext: supported })).toBe(supported);
    expect(getWebMcpModelContext({})).toBeUndefined();
    expect(getWebMcpModelContext(null)).toBeUndefined();

    const session = startWebMcpRegistration(undefined, createChangeGateOperations());
    expect(await session.ready).toEqual({ status: "UNSUPPORTED", toolCount: 0 });
    expect(session.registrationSignal.aborted).toBe(false);
    session.dispose();
    expect(session.registrationSignal.aborted).toBe(true);
  });

  it("aborts prior registrations and stops after a partial failure", async () => {
    const context = new FakeModelContext(3);
    const session = startWebMcpRegistration(context, createChangeGateOperations());

    expect(await session.ready).toEqual({ status: "FAILED", toolCount: 0 });
    expect(context.calls).toHaveLength(3);
    expect(context.live.size).toBe(0);
    expect(session.registrationSignal.aborted).toBe(true);
    expect(context.registrationSignals.every((signal) => signal === session.registrationSignal)).toBe(true);
  });

  it("makes cleanup immediately available while registration is pending", async () => {
    const context = new FakeModelContext(undefined, 1);
    const session = startWebMcpRegistration(context, createChangeGateOperations());

    expect(context.calls).toHaveLength(1);
    session.dispose();
    expect(await session.ready).toEqual({ status: "ABORTED", toolCount: 0 });
    expect(context.calls).toHaveLength(1);
    expect(context.live.size).toBe(0);
  });

  it("keeps callbacks current after state changes without re-registration", async () => {
    const context = new FakeModelContext();
    const session = startWebMcpRegistration(context, createChangeGateOperations());
    await session.ready;
    const invocation = new AbortController();

    expect(
      await invoke(registeredTool(context, "get_change_proposal"), {}, invocation.signal),
    ).toEqual({ status: "NO_ACTIVE_PROPOSAL" });
    expect(
      await invoke(registeredTool(context, "propose_change"), validProposal, invocation.signal),
    ).toMatchObject({ status: "SUCCESS", data: { lifecycle: "PROPOSED" } });
    expect(
      await invoke(registeredTool(context, "get_change_proposal"), {}, invocation.signal),
    ).toMatchObject({ status: "SUCCESS", data: { lifecycle: "PROPOSED" } });
    expect(
      await invoke(
        registeredTool(context, "request_change_approval"),
        { proposalId: validProposal.proposalId },
        invocation.signal,
      ),
    ).toMatchObject({
      status: "SUCCESS",
      data: { lifecycle: "AWAITING_HUMAN_APPROVAL" },
    });
  });

  it("keeps invocation cancellation distinct from registration lifetime", async () => {
    const context = new FakeModelContext();
    const session = startWebMcpRegistration(context, createChangeGateOperations());
    await session.ready;
    const invocation = new AbortController();

    expect(invocation.signal).not.toBe(session.registrationSignal);
    invocation.abort();
    expect(
      await invoke(registeredTool(context, "propose_change"), validProposal, invocation.signal),
    ).toEqual({ status: "CANCELLED" });
    expect(session.registrationSignal.aborted).toBe(false);
    expect(context.live.size).toBe(7);

    session.dispose();
    expect(context.live.size).toBe(0);
  });
});
