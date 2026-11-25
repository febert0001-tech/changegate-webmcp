"use client";

import Link from "next/link";
import { useState } from "react";
import { refundPreviewScope, type ThresholdPreview } from "../../merchant-team/refund-threshold-preview";
import { cents, money, type RefundRequest } from "../../merchant-team/refund-requests";
import styles from "../merchant/merchant.module.css";

export function RefundThresholdPreview({ requests, preview }: {
  requests: RefundRequest[];
  preview: (location: string, shift: string, thresholdCents: number) => Promise<ThresholdPreview>;
}) {
  const [location, setLocation] = useState("");
  const [result, setResult] = useState<ThresholdPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scopes = requests.map(refundPreviewScope);
  const locations = [...new Set(scopes.map(scope => scope.location))].sort();
  const shifts = [...new Set(scopes.filter(scope => scope.location === location).map(scope => scope.shift))].sort();

  return <details className={styles.importSection}>
    <summary>Preview refund threshold</summary>
    <p>Compare the current policy with a proposed USD threshold using the evidence saved when each request was submitted.</p>
    <form className={styles.formRow} onChange={() => { setResult(undefined); setError(""); }} onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      const fields = new FormData(event.currentTarget);
      const amount = String(fields.get("proposed") ?? "").trim();
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(amount)) {
        setError("Enter a USD amount with up to two decimal places.");
        return;
      }
      setBusy(true);
      setResult(undefined);
      setError("");
      try {
        setResult(await preview(location, String(fields.get("shift")), cents(amount)));
      } catch (error) {
        setError(error instanceof Error ? error.message : "Preview unavailable.");
      } finally {
        setBusy(false);
      }
    }}>
      <label>Store<select value={location} onChange={event => setLocation(event.target.value)} required disabled={busy}>
        <option value="">Select a store</option>
        {locations.map(item => <option key={item}>{item}</option>)}
      </select></label>
      <label>Shift<select name="shift" key={location} defaultValue="" required disabled={busy || !location}>
        <option value="">Select a shift</option>
        {shifts.map(item => <option key={item}>{item}</option>)}
      </select></label>
      <label>Proposed threshold (USD)<input name="proposed" inputMode="decimal" required disabled={busy} /></label>
      <button type="submit" disabled={busy || !location}>Run preview</button>
    </form>
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {result && <section aria-label="Refund threshold preview results">
      <dl className={styles.facts}>
        <div><dt>Current threshold</dt><dd>{money(result.currentCents)}</dd></div>
        <div><dt>Proposed threshold</dt><dd>{money(result.proposedCents)}</dd></div>
      </dl>
      <p role="status">Holds added: {result.added} · Holds removed: {result.removed} · Insufficient evidence: {result.insufficient}</p>
      {result.rows.length ? <ul className={styles.queue}>{result.rows.map(row => <li key={row.id}>
        <Link href={"/transactions/" + row.id + "/receipt"} prefetch={false}>View {money(row.amountCents)} refund receipt</Link>
        <dl className={styles.facts}>
          <div><dt>Current policy</dt><dd>{row.current}</dd></div>
          <div><dt>Proposed policy</dt><dd>{row.proposed}</dd></div>
        </dl>
        <p>{row.reason}</p>
      </li>)}</ul> : <p>No saved requests for this store and shift.</p>}
    </section>}
  </details>;
}
