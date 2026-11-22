"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { canReview, money } from "../../merchant-team/refund-requests";
import { shiftGroups, shiftMetrics, type ShiftMetric, type ShiftOverview, type ShiftRefund } from "../../merchant-team/shift-overview";
import styles from "./merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
const total = (rows: { amountCents: number }[]) => rows.reduce((sum, row) => sum + row.amountCents, 0);
const receipt = (id: string) => `/transactions/${id}/receipt`;

function Attention({ row, canDecide }: { row: ShiftRefund; canDecide: boolean }) {
  return <li>
    <Link href={receipt(row.id)} prefetch={false} className={styles.shiftAttentionLink}>
      <div className={styles.shiftAttentionHeading}>
        <strong>{row.location} · {money(row.amountCents)} refund</strong>
        <span>{row.status}</span>
      </div>
      <p>{row.reason}</p>
      <p className={styles.fieldHint}>{row.nextAction} · Open receipt</p>
    </Link>
    {canDecide && row.awaitingApproval &&
      <Link href={`/transactions/${row.id}/approval`} prefetch={false} className={styles.shiftReviewLink}
        aria-label={`Review decision for ${row.location} ${money(row.amountCents)} refund`}>Review decision</Link>}
  </li>;
}

export function ShiftOverviewPanel({ session, send, onSessionError }: {
  session: TeamSession; send: Send; onSessionError: (error: unknown) => boolean;
}) {
  const params = useSearchParams();
  const [overview, setOverview] = useState<ShiftOverview | null>();
  const [error, setError] = useState("");
  const [replaying, setReplaying] = useState(false);
  const replay = useRef({ version: 0, busy: false });
  const detail = useRef<HTMLElement>(null);
  const { demoShift, sessionVersion } = session;
  useEffect(() => {
    if (!demoShift) return;
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || replay.current.busy || controller.signal.aborted) return;
      const version = replay.current.version;
      loading = true;
      try {
        const result = await send<ShiftOverview | null>({ action: "shiftOverview" }, { signal: controller.signal, sessionVersion });
        if (!controller.signal.aborted && version === replay.current.version) { setOverview(result); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted && version === replay.current.version && !onSessionError(e))
          setError("Could not refresh Shift Overview.");
      } finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [demoShift, onSessionError, send, sessionVersion]);

  function updateFilter(key: "location" | "metric", value: string) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    window.history.replaceState(null, "", url);
  }

  async function replayHeldRefund() {
    if (overview === undefined || replay.current.busy) return;
    replay.current.version++;
    replay.current.busy = true;
    setReplaying(true);
    setError("");
    try {
      const result = await send<ShiftOverview>({ action: "replayHeldDemoRefund", runId: overview?.runId ?? null }, { sessionVersion });
      window.history.replaceState(null, "", "/shift-overview");
      setOverview(result);
    } catch (e) {
      if (!onSessionError(e)) setError("Could not replay the shift. Refresh the overview and try again.");
    } finally {
      replay.current.busy = false;
      setReplaying(false);
    }
  }

  const replayButton = <button type="button" className={styles.primary} disabled={replaying}
    onClick={() => void replayHeldRefund()}>{replaying ? "Replaying fictional shift…" : "Replay to held $38 refund"}</button>;

  if (!demoShift) return <section className={styles.card}>
    <h2>Shift Overview</h2><p>No fictional shift is available in this workspace.</p>
  </section>;
  if (!overview) return <section className={styles.card}>
    <h2>Shift Overview</h2>
    <p className={styles.fieldHint}>Fictional shift</p>
    {error && <p role="alert">{error}</p>}
    {overview === undefined ? !error && <p role="status">Loading shift activity…</p> : replayButton}
  </section>;

  const location = overview.locations.find(name => name === params.get("location")) ?? "";
  const selected: ShiftMetric = shiftMetrics.find(([key]) => key === params.get("metric"))?.[0] ?? "approval";
  const groups = shiftGroups(overview, location);
  const attention = groups.refunds.filter(row => row.awaitingApproval || row.awaitingSubmission);
  const rows = groups[selected];
  const heading = shiftMetrics.find(([key]) => key === selected)![1];
  return <section className={`${styles.card} ${styles.shiftOverview}`} aria-labelledby="shift-heading">
    <div className={styles.shiftOverviewHeading}>
      <div><h2 id="shift-heading">Shift Overview</h2><p className={styles.fieldHint}>Fictional shift · {overview.seed}</p></div>
      <div className={styles.shiftOverviewActions}>
        <label>Location<select value={location} onChange={event => updateFilter("location", event.target.value)}>
          <option value="">All locations</option>
          {overview.locations.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {replayButton}
      </div>
    </div>
    {error && <p role="alert">{error}</p>}
    <section aria-labelledby="shift-attention">
      <h3 id="shift-attention">Needs attention</h3>
      {attention.length ? <ul className={styles.shiftAttentionList}>{attention.map(row =>
        <Attention key={row.id} row={row} canDecide={canReview(session.role)}/>)}</ul>
        : <p className={styles.emptyState}>No refunds need attention in this view.</p>}
    </section>
    <section aria-labelledby="shift-totals">
      <h3 id="shift-totals">Shift totals</h3>
      <div className={styles.shiftMetricGrid}>
        {shiftMetrics.map(([key,label]) => <button key={key} type="button" aria-pressed={selected === key}
          aria-controls="shift-matching-records" className={styles.shiftMetric} onClick={() => {
            updateFilter("metric",key);
            detail.current?.scrollIntoView({ block: "nearest" });
          }}>
          <span>{label}</span><strong>{money(total(groups[key]))}</strong><small>{groups[key].length} {groups[key].length === 1 ? "record" : "records"}</small>
        </button>)}
      </div>
      <p className={styles.fieldHint}>Recorded sales use amounts after discounts. Confirmed payouts require independent provider verification.</p>
    </section>
    <section ref={detail} id="shift-matching-records" aria-labelledby="shift-records-heading">
      <h3 id="shift-records-heading">{heading} records</h3>
      <p className={styles.fieldHint}>{location || "All locations"} · {rows.length} {rows.length === 1 ? "record" : "records"} · {money(total(rows))}</p>
      {rows.length ? <ul className={styles.shiftRecords}>{rows.map(row => <li key={row.reference}>
        <div><strong>{row.location} · {money(row.amountCents)}</strong><span>{row.register} · {row.at.slice(11,16)} UTC</span></div>
        {"id" in row ? <><p>{row.status} · {row.cashier}</p><Link href={receipt(row.id)} prefetch={false}>Open receipt for {row.reference}</Link></>
          : <p>{row.reference}{row.discountCents > 0 && ` · ${money(row.discountCents)} discount applied`}</p>}
      </li>)}</ul> : <p className={styles.emptyState}>No matching records.</p>}
    </section>
  </section>;
}
