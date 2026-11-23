"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { canReview, money } from "../../merchant-team/refund-requests";
import { cashStoreDate, cashWeekGroups, originalVarianceTotal, type CashWeek, type CashWeekRow } from "../../merchant-team/weekly-cash-review";
import styles from "./merchant.module.css";

const metrics = [
  ["completed", "Completed closes"], ["short", "Short drawers"], ["over", "Over drawers"],
  ["balanced", "Balanced drawers"], ["unresolved", "Unresolved review cases"],
] as const;
type Metric = typeof metrics[number][0];
type Filters = { week?: string; location?: string };

function varianceLabel(cents: number) {
  if (!cents) return "Balanced";
  return money(Math.abs(cents)) + (cents < 0 ? " short" : " over");
}

function reviewLabel(close: NonNullable<CashWeekRow["close"]>) {
  if (!close.review) return close.variance ? "Needs review · no case opened" : "Balanced";
  if (close.review.status !== "Resolved") return close.review.status;
  return close.review.disposition ?? "Resolved · disposition not recorded";
}

function CloseRow({ row }: { row: CashWeekRow }) {
  const close = row.close;
  if (!close) return null;
  return <li>
    <details>
      <summary>
        <strong>{cashStoreDate(row.openedAt)} · {row.location} · {row.register} · {varianceLabel(close.variance)}</strong>
      </summary>
      <dl className={styles.facts}>
        <div><dt>Expected cash</dt><dd>{money(close.expected)}</dd></div>
        <div><dt>Original count</dt><dd>{money(close.firstCount.cents)} · {close.firstCount.actor}</dd></div>
        <div><dt>Original discrepancy</dt><dd>{varianceLabel(close.variance)}</dd></div>
        <div><dt>Latest recount</dt><dd>{close.recount ? <>
          {money(close.recount.cents)} · {close.recount.actor}
          <br />{close.recount.cents === close.expected ? "Matches expected cash" : "Difference remains"}
          <br />{close.recount.note}
        </> : "No recount recorded"}</dd></div>
        <div><dt>Reviewer</dt><dd>{close.review?.reviewer ?? "No review recorded"}</dd></div>
        <div><dt>Disposition</dt><dd>{reviewLabel(close)}</dd></div>
      </dl>
      <p className={styles.actions}>
        <Link href={`/cash-drawer?id=${row.id}`} prefetch={false}>Open drawer close</Link>
        {close.review && <Link href={`/merchant/${close.review.id}`} prefetch={false}>Open review case</Link>}
      </p>
    </details>
    <p className={styles.fieldHint}>{reviewLabel(close)}</p>
  </li>;
}

export function WeeklyCashReviewPanel({ initial, session, send, onSessionError }: {
  initial: Filters;
  session: TeamSession;
  send: <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
  onSessionError: (error: unknown) => boolean;
}) {
  const [filters, setFilters] = useState(initial);
  const [report, setReport] = useState<CashWeek>();
  const [metric, setMetric] = useState<Metric>("completed");
  const [error, setError] = useState("");
  const [filtering, setFiltering] = useState(false);
  const allowed = Boolean(session.demoShift && canReview(session.role));
  const { sessionVersion } = session;

  useEffect(() => {
    if (!allowed) return;
    const abort = new AbortController();
    void send<CashWeek>({ action: "weeklyCashReview", ...filters }, { sessionVersion, signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setReport(result); })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted && !onSessionError(failure)) setError("The weekly cash review could not be loaded.");
      })
      .finally(() => { if (!abort.signal.aborted) setFiltering(false); });
    return () => abort.abort();
  }, [allowed, filters, onSessionError, send, sessionVersion]);

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const week = String(data.get("week") ?? "");
    const location = String(data.get("location") ?? "");
    setError("");
    setFiltering(true);
    setFilters({ ...(week && { week }), ...(location && { location }) });
    const path = new URL(window.location.href);
    path.search = new URLSearchParams({ ...(week && { week }), ...(location && { location }) }).toString();
    window.history.replaceState(null, "", path);
  }

  const groups = cashWeekGroups(report?.rows ?? []);
  return <section className={`${styles.card} ${styles.shiftOverview}`} aria-labelledby="cash-week-heading">
    <div className={styles.screenHeading}>
      <h2 id="cash-week-heading">Weekly cash review</h2>
      <Link href="/shift-overview" prefetch={false}>Back to Shift Overview</Link>
    </div>
    {!allowed && <p>Weekly cash review is available to supervisors in this demo workspace.</p>}
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!report && allowed && !error && <p role="status">Loading weekly cash review…</p>}
    {report && allowed && <>
      <form className={styles.formRow} key={report.start + (filters.location ?? "")} onSubmit={filter}>
        <label>Date in reporting week<input name="week" type="date" defaultValue={report.start} required /></label>
        <label>Location<select name="location" defaultValue={filters.location ?? ""}>
          <option value="">All locations</option>
          {report.locations.map(location => <option key={location}>{location}</option>)}
        </select></label>
        <button type="submit" className={styles.primary} disabled={filtering}>Show week</button>
      </form>
    </>}
    {allowed && filtering && <p role="status">Loading weekly cash review…</p>}
    {report && allowed && !filtering && !error && <>
      <p className={styles.reviewPeriod}>{report.start} through {report.end} · {report.timeZone} · By shift opening date</p>
      <div className={styles.shiftMetricGrid} aria-label="Cash review totals">
        {metrics.map(([key, label]) => {
          const count = groups[key].length;
          const total = key === "short" || key === "over" ? `${money(originalVarianceTotal(groups[key]))} ${key}` : null;
          return <button type="button" key={key} className={styles.shiftMetric} aria-pressed={metric === key}
            aria-controls="cash-week-rows" onClick={() => setMetric(key)}>
            <span>{label}</span><strong>{total ?? count}</strong>{total && <small>{count} {count === 1 ? "drawer" : "drawers"}</small>}
          </button>;
        })}
      </div>
      <section id="cash-week-rows" aria-labelledby="cash-week-rows-heading">
        <h3 id="cash-week-rows-heading">{metrics.find(([key]) => key === metric)?.[1]}</h3>
        {groups[metric].length ? <ul className={styles.shiftRecords}>
          {groups[metric].map(row => <CloseRow key={row.id} row={row} />)}
        </ul> : <p className={styles.emptyState}>No matching closes.</p>}
      </section>
      <section aria-labelledby="cash-week-incomplete">
        <h3 id="cash-week-incomplete">Incomplete closes · {groups.incomplete.length}</h3>
        {groups.incomplete.length ? <ul className={styles.shiftRecords}>
          {groups.incomplete.map(row => <li key={row.id}>
            <Link href={`/cash-drawer?id=${row.id}`} prefetch={false}>{cashStoreDate(row.openedAt)} · {row.location} · {row.register}</Link>
            <p>First closing count missing</p>
          </li>)}
        </ul> : <p className={styles.fieldHint}>No incomplete closes for this week.</p>}
      </section>
    </>}
  </section>;
}
