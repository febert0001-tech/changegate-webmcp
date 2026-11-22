"use client";

import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  checkDecisionReceiptConsistency,
  readDecisionReceipt,
  type DecisionReceiptSummary,
} from "../application/read-decision-receipt";
import styles from "./page.module.css";

function statusLabel(status: string | null): string {
  if (status === null) return "Unavailable";
  if (status === "PENDING_EXECUTE") return "Pending Execute";
  if (status === "NOT_RUN") return "Verification not run";
  return status[0] + status.slice(1).toLowerCase().replaceAll("_", " ");
}

function ReceiptSummary({ receipt }: { readonly receipt: DecisionReceiptSummary }) {
  const consistency = checkDecisionReceiptConsistency(receipt);
  return (
    <section className={styles.savedReceipt} aria-label="Saved decision receipt">
      <h3>Saved decision receipt</h3>
      <p>Statuses reported by the file.</p>
      <p>{receipt.environment}</p>
      <dl>
        <div><dt>Human decision</dt><dd>{statusLabel(receipt.decision.status)}</dd></div>
        <div><dt>Execution</dt><dd>{statusLabel(receipt.execution.status)}</dd></div>
        <div><dt>Independent verification</dt><dd>{statusLabel(receipt.verification.status)}</dd></div>
      </dl>
      <div className={styles.receiptConsistency} data-consistency={consistency.status}>
        {consistency.status === "consistent" && <strong>Internally consistent</strong>}
        {consistency.status === "inconsistent" && (
          <><strong>Inconsistent receipt</strong><p>{consistency.explanation}</p></>
        )}
        {consistency.status === "unavailable" && <strong>Consistency unavailable</strong>}
      </div>
    </section>
  );
}

export function DecisionReceiptViewer({ children }: { readonly children: ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const [receipt, setReceipt] = useState<DecisionReceiptSummary | "reading" | "invalid" | null>(null);

  async function openReceipt(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    input.value = "";

    const currentSelection = ++selection.current;
    setReceipt("reading");
    let result: DecisionReceiptSummary | null;
    try {
      result = readDecisionReceipt(await file.text());
    } catch {
      result = null;
    }
    if (selection.current === currentSelection) setReceipt(result ?? "invalid");
  }

  return (
    <>
      <div className={styles.auditActions}>
        {children}
        <button className={styles.receiptButton} type="button" onClick={() => inputRef.current?.click()}>
          Open decision receipt
        </button>
        <input ref={inputRef} type="file" aria-label="Choose decision receipt" accept=".json,application/json" hidden onChange={openReceipt} />
      </div>
      <div role="status" aria-atomic="true">
        {receipt === "reading" && <p className={styles.auditEmpty}>Reading decision receipt…</p>}
        {receipt === "invalid" && <p className={styles.auditEmpty}>Could not open this file. Choose a ChangeGate v1 decision receipt.</p>}
        {receipt !== null && typeof receipt === "object" && (
          <ReceiptSummary receipt={receipt} />
        )}
      </div>
    </>
  );
}
