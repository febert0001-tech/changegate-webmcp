import type { ChangeGateOperations } from "../application/changegate-operations";
import type { WebMcpModelContext } from "./native-contract";
import { createGate2ToolDefinitions } from "./tool-catalog";

export type WebMcpRegistrationResult =
  | { readonly status: "REGISTERED"; readonly toolCount: 7 }
  | { readonly status: "UNSUPPORTED"; readonly toolCount: 0 }
  | { readonly status: "FAILED"; readonly toolCount: 0 }
  | { readonly status: "ABORTED"; readonly toolCount: 0 };

export interface WebMcpRegistrationSession {
  readonly ready: Promise<WebMcpRegistrationResult>;
  readonly registrationSignal: AbortSignal;
  readonly dispose: () => void;
}

export function startWebMcpRegistration(
  modelContext: WebMcpModelContext | undefined,
  operations: ChangeGateOperations,
): WebMcpRegistrationSession {
  const controller = new AbortController();

  const ready: Promise<WebMcpRegistrationResult> = modelContext === undefined
    ? Promise.resolve(Object.freeze({ status: "UNSUPPORTED", toolCount: 0 }))
    : (async () => {
        try {
          const definitions = createGate2ToolDefinitions(operations);
          for (const definition of definitions) {
            if (controller.signal.aborted) {
              return Object.freeze({ status: "ABORTED", toolCount: 0 });
            }
            await modelContext.registerTool(definition, { signal: controller.signal });
          }

          return controller.signal.aborted
            ? Object.freeze({ status: "ABORTED", toolCount: 0 })
            : Object.freeze({ status: "REGISTERED", toolCount: 7 });
        } catch {
          const alreadyAborted = controller.signal.aborted;
          controller.abort();
          return alreadyAborted
            ? Object.freeze({ status: "ABORTED", toolCount: 0 })
            : Object.freeze({ status: "FAILED", toolCount: 0 });
        }
      })();

  return Object.freeze({
    ready,
    registrationSignal: controller.signal,
    dispose: () => controller.abort(),
  });
}
