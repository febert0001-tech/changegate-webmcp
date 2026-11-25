"use client";

import Link from "next/link";
import { useState } from "react";
import { refundPreviewScope, syntheticRefundWeek, type RefundPreviewScope, type ThresholdPreview } from "../../merchant-team/refund-threshold-preview";
import { cents, money, type RefundRequest } from "../../merchant-team/refund-requests";
import { addCashWeekDays, cashStoreDate, cashTimeZone, cashWeekMonday } from "../../merchant-team/weekly-cash-review";
import styles from "../merchant/merchant.module.css";

export function RefundThresholdPreview({ requests, preview, previewExample, applyChange, merchantName }: {
  requests: RefundRequest[];
  preview: (scope: RefundPreviewScope) => Promise<ThresholdPreview>;
  previewExample?: ((thresholdCents: number) => Promise<ThresholdPreview>) | undefined;
  applyChange?: ((previewId: string) => Promise<void>) | undefined;
  merchantName: string;
}) {
  const [location, setLocation] = useState("");
  const [scope, setScope] = useState<"shift" | "week">("shift");
  const [example, setExample] = useState(false);
  const [result, setResult] = useState<ThresholdPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const scopes = requests.map(refundPreviewScope);
  const locations = [...new Set(scopes.map(scope => scope.location))].sort();
  const shifts = [...new Set(scopes.filter(scope => scope.location === location).map(scope => scope.shift))].sort();

  async function confirmChange() {
    if (busy || !applyChange || !result?.changePreviewId) return;
    setBusy(true);
    try {
      await applyChange(result.changePreviewId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not apply the threshold.");
    } finally {
      setConfirming(false);
      setResult(undefined);
      setBusy(false);
    }
  }

  return <details className={styles.importSection}>
    <summary>Preview refund threshold</summary>
    <p>Compare the current policy with a proposed USD threshold using the evidence saved when each request was submitted.</p>
    <form className={styles.formRow} onChange={() => { setResult(undefined); setError(""); setConfirming(false); }} onSubmit={async event => {
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
      setConfirming(false);
      try {
        const thresholdCents = cents(amount);
        if (example && previewExample) {
          setResult(await previewExample(thresholdCents));
        } else {
          const selection = scope === "week" ? { week: String(fields.get("week")) } : { shift: String(fields.get("shift")) };
          setResult(await preview({ location, ...selection, thresholdCents }));
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : "Preview unavailable.");
      } finally {
        setBusy(false);
      }
    }}>
      {!example && <label>Store<select value={location} onChange={event => setLocation(event.target.value)} required disabled={busy}>
        <option value="">Select a store</option>
        {locations.map(item => <option key={item}>{item}</option>)}
      </select></label>}
      <label>Reporting scope<select value={scope} onChange={event => {
        setScope(event.target.value === "week" ? "week" : "shift");
        setExample(false);
      }} disabled={busy}>
        <option value="shift">Shift</option>
        <option value="week">Closed week</option>
      </select></label>
      {scope === "week" && previewExample && <label>Closed-week records
        <select value={example ? "synthetic" : "saved"} disabled={busy} onChange={event => setExample(event.target.value === "synthetic")}>
          <option value="saved">Saved refund requests</option>
          <option value="synthetic">Synthetic Harbor Fuel week</option>
        </select>
      </label>}
      {scope === "shift" ? <label>Shift<select name="shift" key={location} defaultValue="" required disabled={busy || !location}>
        <option value="">Select a shift</option>
        {shifts.map(item => <option key={item}>{item}</option>)}
      </select></label> : example ? <p>{syntheticRefundWeek.location} · {syntheticRefundWeek.start} through {syntheticRefundWeek.end} · {cashTimeZone}</p> : <label>Date in closed reporting week
        <input name="week" type="date" max={addCashWeekDays(cashWeekMonday(cashStoreDate(new Date().toISOString())), -1)}
          required disabled={busy} />
        <span className={styles.fieldHint}>Monday through Sunday · {cashTimeZone}</span>
      </label>}
      <label>Proposed threshold (USD)<input name="proposed" inputMode="decimal" required disabled={busy} /></label>
      <button type="submit" disabled={busy || (!example && !location)}>Run preview</button>
    </form>
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {result && <section aria-label="Refund threshold preview results">
      {result.period && <p>{result.period.start} through {result.period.end} · {result.period.timeZone} · By request submission date</p>}
      <dl className={styles.facts}>
        <div><dt>{example ? "Example baseline threshold" : "Current threshold"}</dt><dd>{money(result.currentCents)}</dd></div>
        <div><dt>Proposed threshold</dt><dd>{money(result.proposedCents)}</dd></div>
        <div><dt>Current supervisor reviews</dt><dd>{result.currentReview}</dd></div>
        <div><dt>Projected supervisor reviews</dt><dd>{result.projectedReview}</dd></div>
      </dl>
      <p role="status">Holds added: {result.added} · Holds removed: {result.removed} · Insufficient evidence: {result.insufficient}</p>
      {applyChange && result.changePreviewId && result.proposedCents !== result.currentCents && (
        confirming ? <section aria-label="Confirm threshold change">
          <h4>Confirm threshold change</h4>
          <p>You previewed {location}. This threshold applies to all stores in {merchantName}.</p>
          <p><strong>Current {money(result.currentCents)} → Proposed {money(result.proposedCents)}</strong></p>
          <button type="button" disabled={busy} onClick={() => void confirmChange()}>Confirm and apply threshold</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </section> : <button type="button" onClick={() => setConfirming(true)}>Review threshold change</button>
      )}
      {result.rows.length ? <ul className={styles.queue}>{result.rows.map(row => <li key={row.id}>
        {example ? <strong>{money(row.amountCents)} synthetic refund request</strong> :
          <Link href={"/transactions/" + row.id + "/receipt"} prefetch={false} target="_blank" rel="noopener">
            View {money(row.amountCents)} refund receipt (opens in a new tab)
          </Link>}
        <dl className={styles.facts}>
          <div><dt>Current policy</dt><dd>{row.current}</dd></div>
          <div><dt>Proposed policy</dt><dd>{row.proposed}</dd></div>
        </dl>
        {row.current !== row.proposed ? <details><summary>Why this changes</summary><p>{row.reason}</p></details> :
          <p>{row.reason}</p>}
      </li>)}</ul> : <p>No saved requests for this store and reporting period.</p>}
    </section>}
  </details>;
}
