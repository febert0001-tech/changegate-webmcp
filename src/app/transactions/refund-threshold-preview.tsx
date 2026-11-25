"use client";

import Link from "next/link";
import { useState } from "react";
import { refundPreviewScope, type RefundPreviewScope, type ThresholdPreview } from "../../merchant-team/refund-threshold-preview";
import { cents, money, type RefundRequest } from "../../merchant-team/refund-requests";
import { addCashWeekDays, cashStoreDate, cashTimeZone, cashWeekMonday } from "../../merchant-team/weekly-cash-review";
import styles from "../merchant/merchant.module.css";

export function RefundThresholdPreview({ requests, preview }: {
  requests: RefundRequest[];
  preview: (scope: RefundPreviewScope) => Promise<ThresholdPreview>;
}) {
  const [location, setLocation] = useState("");
  const [scope, setScope] = useState<"shift" | "week">("shift");
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
        const selection = scope === "week" ? { week: String(fields.get("week")) } : { shift: String(fields.get("shift")) };
        setResult(await preview({ location, ...selection, thresholdCents: cents(amount) }));
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
      <label>Reporting scope<select value={scope} onChange={event => setScope(event.target.value === "week" ? "week" : "shift")} disabled={busy}>
        <option value="shift">Shift</option>
        <option value="week">Closed week</option>
      </select></label>
      {scope === "shift" ? <label>Shift<select name="shift" key={location} defaultValue="" required disabled={busy || !location}>
        <option value="">Select a shift</option>
        {shifts.map(item => <option key={item}>{item}</option>)}
      </select></label> : <label>Date in closed reporting week
        <input name="week" type="date" max={addCashWeekDays(cashWeekMonday(cashStoreDate(new Date().toISOString())), -1)}
          required disabled={busy} />
        <span className={styles.fieldHint}>Monday through Sunday · {cashTimeZone}</span>
      </label>}
      <label>Proposed threshold (USD)<input name="proposed" inputMode="decimal" required disabled={busy} /></label>
      <button type="submit" disabled={busy || !location}>Run preview</button>
    </form>
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {result && <section aria-label="Refund threshold preview results">
      {result.period && <p>{result.period.start} through {result.period.end} · {result.period.timeZone} · By request submission date</p>}
      <dl className={styles.facts}>
        <div><dt>Current threshold</dt><dd>{money(result.currentCents)}</dd></div>
        <div><dt>Proposed threshold</dt><dd>{money(result.proposedCents)}</dd></div>
        <div><dt>Current supervisor reviews</dt><dd>{result.currentReview}</dd></div>
        <div><dt>Projected supervisor reviews</dt><dd>{result.projectedReview}</dd></div>
      </dl>
      <p role="status">Holds added: {result.added} · Holds removed: {result.removed} · Insufficient evidence: {result.insufficient}</p>
      {result.rows.length ? <ul className={styles.queue}>{result.rows.map(row => <li key={row.id}>
        <Link href={"/transactions/" + row.id + "/receipt"} prefetch={false}>View {money(row.amountCents)} refund receipt</Link>
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
