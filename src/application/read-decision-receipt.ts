import { z } from "zod";
import { SYNTHETIC_ENVIRONMENT_LABEL } from "./decision-receipt";

const receiptSummarySchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.literal(SYNTHETIC_ENVIRONMENT_LABEL),
  decision: z.object({
    status: z.enum(["NOT_REQUESTED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"]).nullable(),
  }),
  execution: z.object({
    status: z.enum(["NOT_EXECUTED", "PENDING_EXECUTE", "IN_PROGRESS", "EXECUTED", "FAILED"]).nullable(),
  }),
  verification: z.object({
    status: z.enum(["NOT_RUN", "IN_PROGRESS", "VERIFIED", "FAILED"]).nullable(),
  }),
});

export type DecisionReceiptSummary = z.infer<typeof receiptSummarySchema>;

export function readDecisionReceipt(text: string): DecisionReceiptSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  // Keep only display fields from the untrusted file.
  const result = receiptSummarySchema.safeParse(value);
  return result.success ? result.data : null;
}
