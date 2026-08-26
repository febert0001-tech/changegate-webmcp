export interface WebMcpInvocationContext {
  readonly signal: AbortSignal;
}

export interface WebMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly execute: (input: unknown, context: WebMcpInvocationContext) => Promise<unknown>;
}

export interface WebMcpRegistrationOptions {
  readonly signal: AbortSignal;
  readonly exposedTo?: readonly string[];
}

export interface WebMcpModelContext {
  registerTool(
    tool: WebMcpToolDefinition,
    options: WebMcpRegistrationOptions,
  ): Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}

export function getWebMcpModelContext(documentValue: unknown): WebMcpModelContext | undefined {
  try {
    if (!isRecord(documentValue)) return undefined;
    const candidate = documentValue.modelContext;
    if (!isRecord(candidate) || typeof candidate.registerTool !== "function") return undefined;
    return candidate as unknown as WebMcpModelContext;
  } catch {
    return undefined;
  }
}
