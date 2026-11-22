"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { dispositionOptions, reviewSummaryCsv, type Disposition, type ReviewSummary } from "../../merchant-team/review-summary";
import styles from "./merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;

export function ReviewSummaryPanel({ send, session, importId, onSessionError }: {
  send: Send; session: TeamSession; importId: string; onSessionError: (error: unknown) => boolean;
}) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const version = session.sessionVersion;

  useEffect(() => {
    const abort = new AbortController();
    void send<ReviewSummary>({ action: "reviewSummary", id: importId }, { sessionVersion: version, signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setSummary(result); })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted && !onSessionError(failure)) setError(failure instanceof Error ? failure.message : "Summary unavailable.");
      })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [send, importId, onSessionError, version]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch (failure) {
      if (!onSessionError(failure)) setError(failure instanceof Error ? failure.message : "Summary unavailable.");
    } finally { setBusy(false); }
  }

  function download() {
    void run(async () => {
      const latest = await send<ReviewSummary>({ action: "reviewSummary", id: importId }, { sessionVersion: version });
      const url = URL.createObjectURL(new Blob(["\uFEFF", reviewSummaryCsv(latest)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "refund-review-" + latest.period.start + "-to-" + latest.period.end + ".csv";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSummary(latest);
      setNotice("Review summary exported.");
    });
  }

  return <section className={styles.card} aria-labelledby="review-summary-heading">
    <div className={styles.screenHeading}>
      <h2 id="review-summary-heading">Review summary</h2>
      {summary && <button type="button" className={styles.primary} disabled={busy || editing !== null}
        onClick={download}>Export review summary</button>}
    </div>
    <Link href={`/merchant/imports/${importId}`} prefetch={false}>Back to comparison</Link>
    {notice && <p className={styles.inlineNotice} role="status">{notice}</p>}
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!summary && busy && <p role="status">Loading summary…</p>}
    {summary && <>
      <p className={styles.reviewPeriod}>{summary.period.start} to {summary.period.end} · USD</p>
      <dl className={styles.reviewTotals}>
        <div><dt>Matched references</dt><dd>{summary.matches.length}</dd></div>
        <div><dt>Exceptions</dt><dd>{summary.exceptions.length}</dd></div>
        <div><dt>Need investigation</dt><dd>{summary.needsInvestigation}</dd></div>
      </dl>
      <ul className={styles.evidenceRows} aria-label="Rows per file">
        {summary.files.map(file => <li className={styles.evidenceRow} key={file.side}>
          <strong>{file.side === "Merchant" ? "Merchant register" : "Processor export"}</strong>
          <p className={styles.sourceFile}>{file.name}</p>
          <p>{file.accepted} accepted · {file.rejected} rejected</p>
        </li>)}
      </ul>
      {!!summary.matches.length && <details className={styles.importSection}>
        <summary>View matched references</summary>
        <ul className={styles.rejections}>{summary.matches.map(reference => <li key={reference}>{reference}</li>)}</ul>
      </details>}
      <section className={styles.importSection} aria-labelledby="weekly-exceptions">
        <h3 id="weekly-exceptions">Exceptions</h3>
        {summary.counts.length ? <ul className={styles.reviewCounts} aria-label="Exceptions by type">
          {summary.counts.map(({ kind, count }) => <li key={kind}>{kind} · <strong>{count}</strong></li>)}
        </ul> : <p className={styles.emptyState}>No exceptions in this comparison.</p>}
        <ul className={styles.findingList}>{[...summary.exceptions].sort((a, b) =>
          Number(b.needsInvestigation) - Number(a.needsInvestigation)).map(row => <li key={row.id}>
          <article className={styles.importFinding} aria-label={row.reference}>
            <div className={styles.screenHeading}>
              <strong>{row.reference}</strong>
              <span className={styles.evidenceLabel}>{row.needsInvestigation ? "Needs investigation" : "Reviewed"}</span>
            </div>
            <p>{row.kind}. {row.explanation}</p>
            <p>{row.caseId ? <>
              <Link href={`/merchant/${row.caseId}`} prefetch={false}>Open case</Link> · {row.assigneeName} · {row.caseStatus}
            </> : "Unassigned"}</p>
            {row.decision && <div className={styles.reviewDecision}>
              <strong>{row.decision.disposition}</strong>
              <p>{row.decision.note}</p>
              <p className={styles.fieldHint}>{row.decision.reviewer} · <time dateTime={row.decision.recordedAt}>
                {row.decision.recordedAt.replace("T", " ").slice(0, 19)} UTC
              </time></p>
            </div>}
            {editing === row.id ? <form key={row.decision?.revision ?? 0} onSubmit={event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const disposition = data.get("disposition") as Disposition;
              const note = String(data.get("note") ?? "");
              void run(async () => {
                const result = await send<ReviewSummary>({ action: "recordDisposition", id: importId, findingId: row.id,
                  expectedRevision: row.decision?.revision ?? 0, disposition, note }, { sessionVersion: version });
                setSummary(result);
                setEditing(null);
                setNotice("Disposition saved.");
              });
            }}>
              <label>Disposition<select name="disposition" defaultValue={row.decision?.disposition ?? ""} required disabled={busy}>
                <option value="" disabled>Select a disposition</option>
                {dispositionOptions.map(option => <option key={option}>{option}</option>)}
              </select></label>
              <label>Supporting note<textarea name="note" defaultValue={row.decision?.note ?? ""} maxLength={1600} required disabled={busy} /></label>
              <div className={styles.actions}>
                <button className={styles.primary} disabled={busy}>Save disposition</button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </form> : <button type="button" className={styles.reviewEdit} disabled={busy || editing !== null}
              onClick={() => setEditing(row.id)}>{row.decision ? "Update disposition" : "Record disposition"}</button>}
          </article>
        </li>)}</ul>
      </section>
    </>}
  </section>;
}
