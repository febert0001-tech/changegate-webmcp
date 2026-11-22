import type { CaseStatus } from "./contracts";
import type { ComparisonPeriod, ExportSide, FindingKind, RefundImport } from "./refund-csv";

export const dispositionOptions = ["Timing difference", "Merchant record corrected", "Still unresolved"] as const;
export type Disposition = (typeof dispositionOptions)[number];

export interface ReviewDisposition {
  revision: number;
  disposition: Disposition;
  reviewer: string;
  recordedAt: string;
  note: string;
}

export interface ReviewFindingState {
  caseId: string | null;
  assigneeName: string | null;
  caseStatus: CaseStatus | null;
  decision: ReviewDisposition | null;
}

export interface SummaryException extends ReviewFindingState {
  id: string;
  reference: string;
  kind: FindingKind;
  explanation: string;
  needsInvestigation: boolean;
}
export interface ReviewSummary {
  id: string;
  period: ComparisonPeriod;
  files: { side: ExportSide; name: string; accepted: number; rejected: number }[];
  matches: string[];
  counts: { kind: FindingKind; count: number }[];
  exceptions: SummaryException[];
  needsInvestigation: number;
}

export function summarizeComparison(batch: RefundImport, states: Map<string, ReviewFindingState>): ReviewSummary {
  if (!batch.comparison) throw Error("Expected a saved comparison");
  const { files, exact, period } = batch.comparison;
  const accepted = { Merchant: new Set<number>(), Processor: new Set<number>() };
  // Every accepted row is present in exactly one match or exception, including duplicate candidates.
  for (const rows of [...exact, ...batch.findings.map(finding => finding.rows)]) {
    for (const row of rows) {
      if (row.side && !row.rejected) accepted[row.side].add(row.line);
    }
  }
  const counts = new Map<FindingKind, number>();
  const exceptions = batch.findings.map(finding => {
    const state = states.get(finding.id);
    if (!state) throw Error("Saved finding state is unavailable");
    const { decision, caseStatus } = state;
    const needsInvestigation = decision?.disposition === "Still unresolved" ||
      (caseStatus !== "Resolved" && (caseStatus !== null || decision === null));
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    return { ...state, id: finding.id, reference: finding.rows[0]!.reference,
      kind: finding.kind, explanation: finding.explanation, needsInvestigation };
  });
  return {
    id: batch.summary.id, period,
    files: (["Merchant", "Processor"] as const).map(side => ({
      side, name: files[side], accepted: accepted[side].size,
      rejected: batch.rejections.filter(row => row.side === side).length,
    })),
    matches: exact.map(rows => rows[0]!.reference),
    counts: [...counts].map(([kind, count]) => ({ kind, count })),
    exceptions,
    needsInvestigation: exceptions.filter(row => row.needsInvestigation).length,
  };
}

export function reviewSummaryCsv(summary: ReviewSummary) {
  const rows: (string | number)[][] = [
    ["Section", "Item", "Count or value", "Detail", "Case ID", "Assignee", "Case status", "Needs investigation",
      "Disposition", "Reviewer", "Recorded at (UTC)", "Supporting note"],
    ["Summary", "Format version", 1],
    ["Summary", "Comparison ID", summary.id],
    ["Summary", "Period start", summary.period.start],
    ["Summary", "Period end", summary.period.end],
    ["Summary", "Currency", "USD"],
    ["Summary", "Matched references", summary.matches.length],
    ["Summary", "Exceptions", summary.exceptions.length],
    ["Summary", "Needs investigation", summary.needsInvestigation],
  ];
  for (const file of summary.files) {
    rows.push(["File", file.side + " accepted", file.accepted, file.name],
      ["File", file.side + " rejected", file.rejected, file.name]);
  }
  for (const entry of summary.counts) rows.push(["Exception count", entry.kind, entry.count]);
  for (const reference of summary.matches) rows.push(["Match", reference]);
  for (const row of summary.exceptions) {
    rows.push(["Exception", row.reference, row.kind, row.explanation, row.caseId ?? "", row.assigneeName ?? "Unassigned",
      row.caseStatus ?? "", row.needsInvestigation ? "Yes" : "No", row.decision?.disposition ?? "",
      row.decision?.reviewer ?? "", row.decision?.recordedAt ?? "", row.decision?.note ?? ""]);
  }
  const escape = (value: string | number) => {
    const raw = String(value);
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return rows.map(row => Array.from({ length: 12 }, (_, index) => escape(row[index] ?? "")).join(",")).join("\r\n") + "\r\n";
}
