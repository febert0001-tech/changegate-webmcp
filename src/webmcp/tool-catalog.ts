import type { output, ZodType } from "zod";

import type { ChangeGateWebMcpOperations } from "../application/changegate-operations";
import type { WebMcpInvocationContext, WebMcpToolDefinition } from "./native-contract";
import {
  emptyInputSchema,
  parseExternalInput,
  proposeChangeInputSchema,
  requestChangeApprovalInputSchema,
  serviceDetailsInputSchema,
  toWebMcpInputSchema,
} from "./schemas";

export const GATE_2_TOOL_NAMES = Object.freeze([
  "get_environment_status",
  "get_service_details",
  "get_change_policy",
  "get_change_proposal",
  "get_audit_trail",
  "propose_change",
  "request_change_approval",
] as const);

export type Gate2ToolName = (typeof GATE_2_TOOL_NAMES)[number];

export type Gate2ToolResult =
  | { readonly status: "SUCCESS"; readonly data: unknown }
  | { readonly status: "DENIED"; readonly reason: string; readonly lifecycle?: string }
  | { readonly status: "INVALID_INPUT"; readonly reason: "INPUT_VALIDATION_FAILED" }
  | { readonly status: "UNSUPPORTED"; readonly reason: string }
  | { readonly status: "NO_ACTIVE_PROPOSAL" }
  | { readonly status: "CANCELLED" };

function invalidInput(): Gate2ToolResult {
  return Object.freeze({ status: "INVALID_INPUT", reason: "INPUT_VALIDATION_FAILED" });
}

function cancelled(): Gate2ToolResult {
  return Object.freeze({ status: "CANCELLED" });
}

async function executeValidated<Schema extends ZodType>(
  schema: Schema,
  input: unknown,
  context: WebMcpInvocationContext,
  operation: (value: output<Schema>) => Gate2ToolResult,
): Promise<Gate2ToolResult> {
  if (context.signal.aborted) return cancelled();
  const parsed = parseExternalInput(schema, input);
  if (!parsed.success) return invalidInput();
  if (context.signal.aborted) return cancelled();

  try {
    return operation(parsed.data);
  } catch {
    return Object.freeze({ status: "DENIED", reason: "OPERATION_NOT_COMPLETED" });
  }
}

function tool(
  name: Gate2ToolName,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: WebMcpToolDefinition["execute"],
): WebMcpToolDefinition {
  return Object.freeze({ name, description, inputSchema, execute });
}

export function createGate2ToolDefinitions(
  operations: ChangeGateWebMcpOperations,
): readonly WebMcpToolDefinition[] {
  const definitions: readonly WebMcpToolDefinition[] = [
    tool(
      "get_environment_status",
      "Return the bounded synthetic health state of the four ChangeGate services.",
      toWebMcpInputSchema(emptyInputSchema),
      (input, context) =>
        executeValidated(emptyInputSchema, input, context, () => ({
          status: "SUCCESS",
          data: operations.getEnvironmentStatus(),
        })),
    ),
    tool(
      "get_service_details",
      "Return supported synthetic details for one validated ChangeGate service.",
      toWebMcpInputSchema(serviceDetailsInputSchema),
      (input, context) =>
        executeValidated(serviceDetailsInputSchema, input, context, ({ serviceId }) => {
          const service = operations.getServiceDetails(serviceId);
          return service === null
            ? { status: "UNSUPPORTED", reason: "SERVICE_NOT_AVAILABLE" }
            : { status: "SUCCESS", data: service };
        }),
    ),
    tool(
      "get_change_policy",
      "Return bounded ChangeGate facts about exact, single-use human authorization and rollback.",
      toWebMcpInputSchema(emptyInputSchema),
      (input, context) =>
        executeValidated(emptyInputSchema, input, context, () => ({
          status: "SUCCESS",
          data: operations.getChangePolicy(),
        })),
    ),
    tool(
      "get_change_proposal",
      "Return a safe projection of the current proposal when one exists.",
      toWebMcpInputSchema(emptyInputSchema),
      (input, context) =>
        executeValidated(emptyInputSchema, input, context, () => {
          const proposal = operations.getChangeProposal();
          return proposal === null
            ? { status: "NO_ACTIVE_PROPOSAL" }
            : { status: "SUCCESS", data: proposal };
        }),
    ),
    tool(
      "get_audit_trail",
      "Return the bounded deterministic ChangeGate audit projection.",
      toWebMcpInputSchema(emptyInputSchema),
      (input, context) =>
        executeValidated(emptyInputSchema, input, context, () => ({
          status: "SUCCESS",
          data: operations.getAuditTrail(),
        })),
    ),
    tool(
      "propose_change",
      "Propose only the supported synthetic Agent Gateway restart; this grants no authority.",
      toWebMcpInputSchema(proposeChangeInputSchema),
      (input, context) =>
        executeValidated(proposeChangeInputSchema, input, context, (proposal) => {
          const result = operations.proposeChange(proposal);
          return result.status === "SUCCESS"
            ? { status: "SUCCESS", data: result.proposal }
            : {
                status: "DENIED",
                reason: result.reason,
                lifecycle: result.lifecycle,
              };
        }),
    ),
    tool(
      "request_change_approval",
      "Request visible human review for the exact current proposal; this never approves it.",
      toWebMcpInputSchema(requestChangeApprovalInputSchema),
      (input, context) =>
        executeValidated(requestChangeApprovalInputSchema, input, context, ({ proposalId }) => {
          const result = operations.requestChangeApproval(proposalId);
          return result.status === "SUCCESS"
            ? { status: "SUCCESS", data: result.proposal }
            : {
                status: "DENIED",
                reason: result.reason,
                lifecycle: result.lifecycle,
              };
        }),
    ),
  ];

  return Object.freeze(definitions);
}
