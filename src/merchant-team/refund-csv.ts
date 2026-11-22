import { z } from "zod";
import { TeamError } from "./error";

export const csvLimit = 96 * 1024;
export const maxRows = 1000;
const maxColumns = 48;
export const csvText = z.string().min(1).max(csvLimit);
const column = z.number().int().min(0).max(maxColumns - 1);
export const refundMapping = z.strictObject({
  reference: column, amount: column, currency: column, status: column.optional(),
}).refine(mapping => new Set(Object.values(mapping)).size === Object.values(mapping).length);
export type RefundMapping = z.infer<typeof refundMapping>;
export type RefundRow = { line: number; reference: string; amountCents: number; status?: string };
export type ExportSide = "Merchant" | "Processor";
export type EvidenceRow = Omit<RefundRow, "amountCents"> & { amountCents: number | null; side?: ExportSide; rejected?: true };
export type Rejection = { line: number; reasons: string[]; side?: ExportSide };
export type ComparisonPeriod = { start: string; end: string };
export type ComparisonEvidence = {
  period: ComparisonPeriod;
  files: Record<ExportSide, string>;
  exact: EvidenceRow[][];
};
export type CaseComparison = Omit<ComparisonEvidence, "exact">;
export type FindingKind = "Repeated reference" | "Status needs review" | "Amount difference" | "Merchant only" | "Processor only" | "Ambiguous reference";
export type RefundFinding = { kind: FindingKind; explanation: string; rows: EvidenceRow[]; differenceCents?: number };
export interface SavedFinding extends RefundFinding { id: string; caseId: string | null; }
export type ImportSummary = { id: string; importedAt: string; acceptedCount: number; rejectedCount: number; findingCount: number };
export type RefundImport = { summary: ImportSummary; findings: SavedFinding[]; rejections: Rejection[]; comparison?: ComparisonEvidence };
export interface RefundImportResult { batch: RefundImport; existing: boolean }
export interface CaseEvidence { importId: string; finding: SavedFinding; comparison?: CaseComparison }
type CsvRow = { line: number; cells: string[] };

function bad(code: string): never { throw new TeamError(code, 422); }

// Quoted fields, embedded newlines and positive integer cents follow the standalone review in PR #16.
function parseCsv(raw: string): CsvRow[] {
  if (new TextEncoder().encode(raw).length > csvLimit) bad("CSV_TOO_LARGE");
  if (/\u0000|\uFFFD/.test(raw)) bad("CSV_ENCODING");
  const input = raw.replace(/^\uFEFF/, "");
  const rows: CsvRow[] = [];
  let cells: string[] = [], value = "", quoted = false, closed = false, line = 1, start = 1;
  function cell() {
    cells.push(value);
    if (cells.length > maxColumns) bad("CSV_LIMIT");
    value = "";
    closed = false;
  }
  function row() {
    cell();
    if (cells.some(item => item.trim())) rows.push({ line: start, cells });
    if (rows.length > maxRows + 1) bad("CSV_LIMIT");
    cells = [];
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted && char === '"') {
      if (input[i + 1] === '"') { value += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      if (quoted) { value += "\n"; line++; }
      else { row(); start = ++line; }
    } else if (quoted) value += char;
    else if (char === ",") cell();
    else if (char === '"' && !value && !closed) quoted = true;
    else if (char === '"' || closed) bad("CSV_QUOTING");
    else value += char;
  }
  if (quoted) bad("CSV_QUOTING");
  row();
  return rows;
}

function source(raw: string) {
  const [header, ...rows] = parseCsv(raw);
  if (!header || header.cells.length < 3 || !rows.length) bad("CSV_EMPTY");
  const headers = header.cells.map(label => label.trim().slice(0, 120));
  return { headers, rows };
}

export function inspectRefundCsv(raw: string) {
  const { headers, rows } = source(raw);
  return { headers, rowCount: rows.length };
}

function cents(raw: string) {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fractions = ""] = raw.split(".");
  const result = Number(whole) * 100 + Number(fractions.padEnd(2, "0"));
  return result > 0 ? result : null;
}

export function reviewRefundCsv(raw: string, mapping: RefundMapping, includeCandidates = false) {
  const { headers, rows } = source(raw);
  if (Object.values(mapping).some(index => index !== undefined && index >= headers.length)) bad("CSV_MAPPING");
  const accepted: RefundRow[] = [], rejections: Rejection[] = [];
  const findings: RefundFinding[] = [];
  const candidates: EvidenceRow[] = [];
  const byReference = new Map<string, RefundRow[]>();
  for (const { line, cells } of rows) {
    const get = (index: number) => cells[index]?.trim() ?? "";
    const reference = get(mapping.reference);
    const amountCents = cents(get(mapping.amount));
    const currency = get(mapping.currency).toUpperCase();
    const status = mapping.status === undefined ? undefined : get(mapping.status);
    const reasons: string[] = [];
    if (cells.length !== headers.length) reasons.push("Column count differs from the header.");
    const validReference = reference && reference.length <= 160 && !/[\u0000-\u001f\u007f]/.test(reference);
    if (!validReference) reasons.push("Use a refund reference of 1 to 160 characters without line breaks.");
    if (amountCents === null) reasons.push("Amount must be a positive number with up to two decimal places.");
    if (currency !== "USD") reasons.push("Currency must be USD.");
    if (status && (status.length > 64 || /[\u0000-\u001f\u007f]/.test(status))) reasons.push("Status must be at most 64 characters without line breaks.");
    if (reasons.length || amountCents === null) {
      rejections.push({ line, reasons });
      if (includeCandidates && validReference) candidates.push({ line, reference, amountCents: currency === "USD" ? amountCents : null, rejected: true });
      continue;
    }
    const evidence: RefundRow = { line, reference, amountCents, ...(status !== undefined && { status }) };
    accepted.push(evidence);
    if (includeCandidates) candidates.push(evidence);
    const group = byReference.get(reference) ?? [];
    group.push(evidence);
    byReference.set(reference, group);
    if (status !== undefined && status.toUpperCase() !== "COMPLETED") {
      findings.push({ kind: "Status needs review", rows: [evidence], explanation:
        status ? "This row labels the refund " + status + ". Confirm the current status with the source."
          : "The mapped status is blank. Confirm the status with the source." });
    }
  }
  for (const group of byReference.values()) {
    if (group.length > 1) findings.push({ kind: "Repeated reference", rows: group, explanation:
      group.length + " accepted rows share this refund reference. The file alone cannot establish that money moved twice." });
  }
  return { accepted, candidates, rejections, findings: findings.sort((a, b) => a.rows[0]!.line - b.rows[0]!.line) };
}
