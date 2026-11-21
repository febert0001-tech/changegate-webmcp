import { z } from "zod";
import type { WebMcpToolDefinition } from "../webmcp/native-contract";
import { parseExternalInput, toWebMcpInputSchema } from "../webmcp/schemas";
import type { Gate2ToolName } from "../webmcp/tool-catalog";
import { cents, providerReference, type MerchantCaseDetail, type MerchantCommand } from "./contracts";

type AgentCommand = Extract<MerchantCommand, { action: "session" | "find" | "case" | "propose" | "review" }>;

export function merchantWebMcp(
  request: (command: AgentCommand, signal?: AbortSignal) => Promise<unknown>,
  policy: { maxRefundCents: number },
): readonly WebMcpToolDefinition[] {
  function tool<S extends z.ZodType>(
    name: Gate2ToolName,
    description: string,
    schema: S,
    act: (input: z.output<S>, signal?: AbortSignal) => Promise<unknown>,
  ): WebMcpToolDefinition {
    return {
      name, description, inputSchema: toWebMcpInputSchema(schema),
      async execute(raw, context) {
        if (context?.signal?.aborted) return { status: "CANCELLED" };
        const input = parseExternalInput(schema, raw);
        if (!input.success) return { status: "INVALID_INPUT" };
        try {
          return { status: "SUCCESS", data: await act(input.data, context?.signal) };
        } catch {
          return { status: context?.signal?.aborted ? "CANCELLED" : "DENIED" };
        }
      },
    };
  }

  const empty = z.strictObject({});
  const caseInput = z.strictObject({ id: z.uuid() });
  return [
    tool("get_environment_status", "Inspect the signed-in sandbox environment.", empty,
      (_, signal) => request({ action: "session" }, signal)),
    tool("get_service_details", "Find merchant-owned captures by order or capture reference.",
      z.strictObject({ kind: z.enum(["order", "capture"]), reference: providerReference }),
      (input, signal) => request({ action: "find", ...input }, signal)),
    tool("get_change_policy", "Read the refund limits and authority requirements.", empty,
      async () => ({ currency: "USD", maxRefundCents: policy.maxRefundCents, humanDecisionAndExecuteRequired: true })),
    tool("get_change_proposal", "Read a refund case by its ID.", caseInput,
      async (input, signal) => (await request({ action: "case", ...input }, signal) as MerchantCaseDetail).case),
    tool("get_audit_trail", "Read the ordered audit history for a refund case.", caseInput,
      async (input, signal) => (await request({ action: "case", ...input }, signal) as MerchantCaseDetail).audit),
    tool("propose_change", "Propose a partial refund in cents or use null for the full remaining balance.",
      z.strictObject({ captureId: providerReference, amountCents: cents.nullable() }),
      (input, signal) => request({ action: "propose", ...input }, signal)),
    tool("request_change_approval", "Send the exact refund proposal to human review.",
      z.strictObject({ id: z.uuid(), version: z.number().int().positive() }),
      (input, signal) => request({ action: "review", ...input }, signal)),
  ];
}
