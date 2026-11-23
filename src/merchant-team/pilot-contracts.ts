import { z } from "zod";
import { csvText, refundMapping } from "./refund-csv";

const id = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const minutes = z.number().finite().nonnegative().max(10080).nullable();
export const pilotSides = ["Merchant", "Processor"] as const;
export const pilotOutcomes = ["confirmed", "incorrect flag", "unresolved"] as const;
export const pilotDecisions = ["continue", "revise", "stop"] as const;
export const pilotFile = z.strictObject({
  text: csvText, mapping: refundMapping, name: z.string().trim().min(1).max(160).regex(/^[^\p{Cc}\\/]+$/u)
});
export const pilotCommands = [
  z.strictObject({ action: z.literal("listPilots") }),
  z.strictObject({ action: z.literal("openPilot"), id }),
  z.strictObject({ action: z.literal("startPilot"), location: text(120), register: text(120),
    week: z.iso.date(), timeZone: text(100), synthetic: z.boolean() }),
  z.strictObject({ action: z.literal("loadFictionalPilotFile"), id, source: z.enum(pilotSides) }),
  z.strictObject({ action: z.literal("inspectPilotCsv"), text: csvText }),
  z.strictObject({ action: z.literal("attachPilotFile"), id, source: z.enum(pilotSides), scopeConfirmed: z.literal(true), file: pilotFile }),
  z.strictObject({ action: z.literal("savePilotBaseline"), id, minutes,
    exceptions: z.array(text(240)).max(100).nullable() }),
  z.strictObject({ action: z.literal("revealPilot"), id }),
  z.strictObject({ action: z.literal("decidePilotIssue"), id, caseId: id,
    outcome: z.enum(pilotOutcomes), revision: z.number().int().nonnegative(), note: z.string().trim().max(400) }),
  z.strictObject({ action: z.literal("addPilotMiss"), id, reference: text(160), note: text(400) }),
  z.strictObject({ action: z.literal("savePilotTime"), id, review: minutes, setup: minutes, waiting: minutes }),
  z.strictObject({ action: z.literal("savePilotDecision"), id, decision: z.enum(pilotDecisions), note: z.string().trim().max(400) }),
] as const;
export type PilotCommand = z.infer<(typeof pilotCommands)[number]>;
