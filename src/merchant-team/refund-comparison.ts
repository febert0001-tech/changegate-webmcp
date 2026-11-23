import { z } from "zod";
import { csvText, refundMapping, reviewRefundCsv, type ComparisonEvidence, type EvidenceRow,
  type RefundFinding } from "./refund-csv";

const fileInput = z.strictObject({
  text: csvText,
  mapping: refundMapping,
  name: z.string().trim().min(1).max(160).regex(/^[^\p{Cc}\\/]+$/u),
});

export const comparisonInput = z.strictObject({
  merchant: fileInput,
  processor: fileInput,
  period: z.strictObject({ start: z.iso.date(), end: z.iso.date() })
    .refine(({ start, end }) => start <= end),
});

export type ComparisonInput = z.infer<typeof comparisonInput>;
export const formatUsd = (cents: number) => usd.format(cents / 100);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function compareRefunds({ merchant, processor, period }: ComparisonInput) {
  return compareReviewedRefunds(reviewRefundCsv(merchant.text, merchant.mapping, true),
    reviewRefundCsv(processor.text, processor.mapping, true),
    { period, files: { Merchant: merchant.name, Processor: processor.name }, exact: [] });
}

export function compareReviewedRefunds(register: ReturnType<typeof reviewRefundCsv>,
  exportReview: ReturnType<typeof reviewRefundCsv>, comparison: ComparisonEvidence) {
  const accepted = [...register.accepted, ...exportReview.accepted];
  const rejections = [
    ...register.rejections.map(row => ({ ...row, side: "Merchant" as const })),
    ...exportReview.rejections.map(row => ({ ...row, side: "Processor" as const })),
  ];
  const grouped = new Map<string, { Merchant: EvidenceRow[]; Processor: EvidenceRow[] }>();
  for (const [side, candidates] of [["Merchant", register.candidates], ["Processor", exportReview.candidates]] as const) {
    for (const row of candidates) {
      const group = grouped.get(row.reference) ?? { Merchant: [], Processor: [] };
      group[side].push({ ...row, side });
      grouped.set(row.reference, group);
    }
  }
  const findings: RefundFinding[] = [];
  for (const group of grouped.values()) {
    const rows = [...group.Merchant, ...group.Processor];
    const [left] = group.Merchant;
    const [right] = group.Processor;
    if (group.Merchant.length > 1 || group.Processor.length > 1) {
      findings.push({ kind: "Ambiguous reference", rows,
        explanation: "At least one export repeats this refund reference. Review the candidate rows before choosing a match." });
    } else if (rows.some(row => row.rejected)) {
      findings.push({ kind: "Ambiguous reference", rows,
        explanation: "A source row for this refund reference was rejected. Correct the row before relying on a match." });
    } else if (!left || !right) {
      const present = left ? "merchant" : "processor";
      const absent = left ? "processor" : "merchant";
      findings.push({ kind: left ? "Merchant only" : "Processor only", rows,
        explanation: "This reference appears in the " + present + " export and is absent from the " + absent +
          " export. Its payment outcome is unverified." });
    } else if (left.amountCents === right.amountCents) {
      comparison.exact.push(rows);
    } else {
      // Rows with unavailable USD amounts are marked rejected before reaching this branch.
      const leftAmount = left.amountCents!;
      const rightAmount = right.amountCents!;
      const differenceCents = Math.abs(leftAmount - rightAmount);
      findings.push({ kind: "Amount difference", rows, differenceCents,
        explanation: "The merchant export shows " + formatUsd(leftAmount) + " and the processor export shows " +
          formatUsd(rightAmount) + ", a difference of " + formatUsd(differenceCents) + "." });
    }
  }
  return { accepted, rejections, findings, comparison };
}
