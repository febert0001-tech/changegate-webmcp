import { watchWindowMs } from "./refund-monitor-rules";
import { checks, type RefundRequest } from "./refund-requests";
import type { RefundAlertStore } from "./refund-alert-store";
import type { Employee } from "./contracts";

type Result = { summary: string; model: string; responseMs: number; usage?: { input: number; output: number } };
export type DemoExplanation = { status: "pending" | "unavailable" } | ({ status: "complete" } & Result);

export async function explainAlert(evidence: string, key: string, model: string): Promise<Result | null> {
  const started = performance.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000), body: JSON.stringify({ model, store: false, max_output_tokens: 180,
      instructions: "Summarize only the supplied refund rule evidence in one short sentence. Give no approval, accusation, or payment instruction.",
      input: evidence, text: { format: { type: "json_schema", name: "refund_advisory", strict: true, schema: {
        type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false,
      } } },
    }),
  });
  if (!response.ok) return null;
  const data = await response.json() as { status?: string; model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    output?: { content?: { type?: string; text?: string }[] }[] };
  const output = data.output?.flatMap(item => item.content ?? []).find(item => item.type === "output_text")?.text;
  if (data.status !== "completed" || !output) return null;
  const summary = (JSON.parse(output) as { summary?: unknown }).summary;
  if (typeof summary !== "string" || !summary.trim()) return null;
  const { input_tokens: input, output_tokens: outputTokens } = data.usage ?? {};
  const usage = input !== undefined && outputTokens !== undefined && Number.isSafeInteger(input) &&
    Number.isSafeInteger(outputTokens) && input >= 0 && outputTokens >= 0 ? { input, output: outputTokens } : undefined;
  return { summary: summary.trim().slice(0,500), model: data.model ?? model,
    responseMs: Math.round(performance.now() - started), ...(usage && { usage }) };
}

export function demoExplanation(store: RefundAlertStore, employee: Employee, request: RefundRequest): DemoExplanation | undefined {
  const { monitoring, route } = checks(request);
  if (request.sale?.shift !== "Demo shift" || route !== "manager" || !monitoring ||
      monitoring.cashierWatchCount < 3 || monitoring.registerWatchCount < 3) return undefined;
  const existing = store.readDemoExplanation(employee, request.id);
  if (existing) return existing;
  const key = process.env.CHANGEGATE_MONITOR_AI_KEY;
  const model = process.env.CHANGEGATE_MONITOR_AI_MODEL;
  if (!key || !model) return { status: "unavailable" };
  if (!store.claimDemoExplanation(employee, request.id)) return store.readDemoExplanation(employee, request.id);

  const evidence = JSON.stringify({ windowMinutes: watchWindowMs / 60_000, threshold: 3, rules: [
    { label: "Unusual refunds by the same cashier across registers", count: monitoring.cashierWatchCount },
    { label: "Unusual refunds at the same register across cashiers", count: monitoring.registerWatchCount },
  ] });
  void explainAlert(evidence, key, model)
    .catch(() => null)
    .then(result => store.finishDemoExplanation(employee, request.id, result ? { status: "complete", ...result } : { status: "unavailable" }))
    .catch(() => { /* A replay or shutdown can remove the synthetic request while the call is pending. */ });
  return { status: "pending" };
}
