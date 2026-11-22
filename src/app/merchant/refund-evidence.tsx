import { formatUsd } from "../../merchant-team/refund-comparison";
import type { CaseComparison, EvidenceRow, RefundFinding } from "../../merchant-team/refund-csv";
import styles from "./merchant.module.css";

export function findingTitle(finding: Pick<RefundFinding, "kind" | "differenceCents" | "rows">) {
  switch (finding.kind) {
    case "Amount difference": return finding.differenceCents === undefined ? "Refund amounts differ" :
      "Refund amounts differ by " + formatUsd(finding.differenceCents);
    case "Merchant only": return "Missing from the processor export";
    case "Processor only": return "Missing from the merchant register";
    case "Ambiguous reference": return finding.rows.filter(row => row.side === "Merchant").length > 1 ||
      finding.rows.filter(row => row.side === "Processor").length > 1 ? "Refund reference appears more than once" : "Matching row was rejected";
    case "Repeated reference": return "Refund reference appears more than once";
    case "Status needs review": return "Refund status needs review";
  }
}

function rowStatus(row: EvidenceRow) {
  if (row.rejected) return "Rejected row";
  return row.status === undefined ? "" : row.status || "Blank";
}

export function EvidenceRows({ rows, files }: { rows: EvidenceRow[]; files?: CaseComparison["files"] }) {
  return <ul className={styles.evidenceRows} aria-label="Source rows">
    {rows.map(row => {
      const status = rowStatus(row);
      return <li className={styles.evidenceRow} key={`${row.side ?? ""}:${row.line}`}>
      <p className={styles.evidenceLabel}>{row.side ? row.side + " export" : "Refund CSV"} · Row {row.line}</p>
      {row.side && files && <p className={styles.sourceFile}>{files[row.side]}</p>}
      <strong className={styles.sourceAmount}>{row.amountCents === null ? "Amount unavailable" : formatUsd(row.amountCents)}</strong>
      <p>{row.reference}</p>
      {status && <p className={styles.sourceFile}>File status · {status}</p>}
      </li>;
    })}
  </ul>;
}
