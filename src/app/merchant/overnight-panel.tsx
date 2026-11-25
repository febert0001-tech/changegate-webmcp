"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import type { OvernightOwner, OvernightQueue } from "../../merchant-team/overnight";
import { coverageUpdated } from "../../merchant-team/coverage-time";
import { money } from "../../merchant-team/refund-requests";
import { canReplayOvernight, overnightReplayHref } from "../../merchant-team/overnight-replay";
import styles from "./merchant.module.css";

type Props = {
  session: TeamSession;
  send: <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
  onSessionError: (error: unknown) => boolean;
};
type Case = OvernightQueue["cases"][number];
const time = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York"
});
const when = (value: string) => time.format(new Date(value)) + " Eastern";
const amount = (item: Case) => money(Math.abs(item.variance)) + (item.variance < 0 ? " short" : " over");
const followUp = (item: Case) => item.progress?.handoff;
const message = (error: unknown) => error instanceof Error ? error.message : "The desk could not refresh.";

function waiting(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " hr";
  return Math.floor(hours / 24) + " d";
}

function Handoff({ item }: { item: Case }) {
  const handoff = followUp(item);
  if (!handoff) return null;
  return <>
    <p><strong>{handoff.actor} · {when(handoff.at)}</strong></p>
    <p>Checked: {handoff.checked}</p>
    <p><strong>Question: {handoff.question}</strong></p>
    {handoff.reply && <p><strong>{handoff.reply.actor} replied · {when(handoff.reply.at)}</strong><br />{handoff.reply.text}</p>}
  </>;
}

export function OvernightReviewer({ id, session, send, onSessionError }: Props & { id?: string }) {
  const [view, setView] = useState<OvernightQueue>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { sessionVersion } = session;
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const data = await send<OvernightQueue>({ action: "overnightDesk", ...(id && { id }) },
          { sessionVersion, signal: controller.signal });
        if (!controller.signal.aborted) { setView(data); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) { setView(undefined); if (!onSessionError(error)) setError(message(error)); }
      } finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => { if (!busy) void load(); }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [sessionVersion, id, send, onSessionError, busy]);

  async function write(command: TeamCommand) {
    setBusy(true);
    setError("");
    try {
      const detail = await send<NonNullable<OvernightQueue["detail"]>>(command, { sessionVersion });
      setView(current => current ? { ...current, detail } : current);
    } catch (error) {
      if (!onSessionError(error)) setError(message(error));
    } finally { setBusy(false); }
  }

  const item = view?.detail;
  const claimant = item?.progress?.claimant;
  const grantId = claimant?.grantId;
  const canAsk = grantId && claimant?.username === session.username && (!item?.progress?.handoff || item.progress.handoff.reply);
  return <section className={styles.card + " " + styles.overnightPanel} aria-label="Overnight review desk">
    <h2>Overnight review desk</h2>
    <p className={styles.fieldHint}>Managed-service demonstration · Simulated coverage</p>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {id && <Link href="/overnight-review" prefetch={false}>Back to work queue</Link>}
    {!view && !error && <p role="status">Loading cases…</p>}
    {view && !id && <ul className={styles.shiftAttentionList}>{view.cases.length === 0
      ? <li>No open cases for your assigned stores.</li>
      : view.cases.map(row => <li key={row.id}>
        <Link className={styles.shiftAttentionLink} href={`/overnight-review?id=${row.id}`} prefetch={false}>
          <strong>{row.location} · {amount(row)}</strong>
          <p>{row.reason || "Drawer discrepancy requires review"}</p>
          <p className={styles.fieldHint}>Waiting {waiting(row.openedAt)} · Next action: {row.responsible}</p>
        </Link></li>)}
    </ul>}
    {item && <div className={styles.overnightDetails}>
      <h3>{item.location} · {amount(item)}</h3>
      <p>{item.reason || "Drawer discrepancy requires review"}</p>
      <h4>Original drawer close · {item.evidence.register}</h4>
      <p>Expected {money(item.evidence.report.expected)} · Counted {money(item.evidence.report.firstCount.cents)}</p>
      <p>First count by {item.evidence.report.firstCount.actor} · {when(item.evidence.report.firstCount.at)}</p>
      <details><summary>View drawer entries and recounts</summary>
        <ul>
          <li>Opening float {money(item.evidence.opening.cents)} · {item.evidence.opening.actor}</li>
          {item.evidence.report.entries.map(entry => <li key={entry.kind + entry.id}>{entry.kind} · {money(entry.cents)} · {entry.actor} · {entry.note}</li>)}
          {item.evidence.report.followUps.map(entry => <li key={entry.id}>{entry.actor} · {when(entry.at)} · {
            entry.cents === null ? "Explanation" : "Recount " + money(entry.cents)} · {entry.note}</li>)}
        </ul>
      </details>
      <p>Responsible now: {item.responsible}</p>
      {claimant && <p>Assigned to {claimant.actor} · {when(claimant.at)}</p>}
      {item.canClaim && <button type="button" className={styles.primary} disabled={busy}
        onClick={() => void write({ action: "claimOvernightCase", id: item.id })}>Claim case</button>}
      <Handoff item={item} />
      {canAsk && <form key={grantId} onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        void write({ action: "requestOvernightFollowUp", id: item.id, grantId, requestId: crypto.randomUUID(),
          checked: String(fields.get("checked")), question: String(fields.get("question")) });
      }}>
        <label>What you checked<textarea name="checked" maxLength={1200} required /></label>
        <label>Question for the owner<textarea name="question" maxLength={1200} required /></label>
        <button type="submit" className={styles.primary} disabled={busy}>Needs owner follow-up</button>
      </form>}
    </div>}
  </section>;
}

export function OvernightOwnerPanel({ session, send, onSessionError, replay }: Props & { replay?: string }) {
  const router = useRouter();
  const pendingReplay = useRef<string | undefined>(undefined);
  const [view, setView] = useState<OvernightOwner>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { sessionVersion } = session;
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const data = await send<OvernightOwner>({ action: "overnightOwner", ...(replay && { replay }) },
          { sessionVersion, signal: controller.signal });
        if (!controller.signal.aborted) setView(data);
      } catch (error) {
        if (!controller.signal.aborted && !onSessionError(error)) setError(message(error));
      } finally { loading = false; }
    }
    void load();
    const refresh = () => { if (!busy) void load(); };
    window.addEventListener(coverageUpdated, refresh);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener(coverageUpdated, refresh);
    };
  }, [sessionVersion, send, onSessionError, busy, replay]);

  async function startReplay() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const id = pendingReplay.current ??= crypto.randomUUID();
      const started = await send<{ id: string }>({ action: "startOvernightReplay", id }, { sessionVersion });
      router.push(overnightReplayHref(started.id));
    } catch (error) {
      if (!onSessionError(error)) setError(message(error));
      setBusy(false);
    }
  }

  async function write(command: TeamCommand) {
    setBusy(true);
    setError("");
    try { setView(await send<OvernightOwner>(command, { sessionVersion })); }
    catch (error) { if (!onSessionError(error)) setError(message(error)); }
    finally { setBusy(false); }
  }

  return <section className={styles.card + " " + styles.overnightPanel} aria-label="Overnight handoff">
    <h2>Overnight handoff</h2>
    <p className={styles.fieldHint}>Managed-service demonstration · Simulated coverage</p>
    {canReplayOvernight(session) && <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => void startReplay()}>Replay overnight review</button>
      {Boolean(view?.replays?.length) && <details>
        <summary>Saved overnight replays</summary>
        <ul>{view?.replays?.map((run, index, runs) => <li key={run.id}>
          <Link href={overnightReplayHref(run.id)} prefetch={false} aria-current={run.id === replay ? "page" : undefined}>
            Replay {runs.length - index} · {when(run.createdAt)}
          </Link>
        </li>)}</ul>
      </details>}
    </div>}
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!view && !error && <p role="status">Loading handoffs…</p>}
    {view && <>
      {!view.cases.length && <p>No overnight handoffs yet.</p>}
      {view.cases.map(item => {
        const handoff = followUp(item);
        const pending = handoff && !handoff.reply;
        const ended = item.progress?.shiftEnd;
        return <article key={item.id} className={styles.overnightDetails}>
          <h3>{item.location} · {pending ? money(Math.abs(item.variance)) + " awaiting your follow-up" : amount(item)}</h3>
          <p><strong>Responsible now: {item.responsible}</strong></p>
          {ended && <>
            {!pending && <p><strong>Reviewer shift ended — needs reassignment</strong></p>}
            <p>{ended.reviewer.actor} · {ended.reason} · {when(ended.at)}</p>
          </>}
          {item.lastAction && <p>Last completed action: {item.lastAction.kind} · {item.lastAction.actor} · {when(item.lastAction.occurredAt)}</p>}
          <Handoff item={item} />
          <Link href={`/merchant/${item.id}`} prefetch={false}>Open same case and full history</Link>
          {pending && <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            void write({ action: "replyOvernight", id: item.id, requestId: handoff.requestId, text: String(fields.get("reply")) });
          }}>
            <label>Your reply<textarea name="reply" maxLength={1200} required /></label>
            <button type="submit" className={styles.primary} disabled={busy}>Reply on case</button>
          </form>}
          {ended && !pending && (item.eligible.length ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            void write({ action: "reassignOvernightCase", id: item.id, endedAt: ended.at,
              reviewer: String(fields.get("nextReviewer")) });
          }}>
            <label>Next reviewer<select name="nextReviewer" required defaultValue="">
              <option value="">Select a reviewer with active coverage</option>
              {item.eligible.map(reviewer => <option value={reviewer.username} key={reviewer.username}>{reviewer.name}</option>)}
            </select></label>
            <button type="submit" className={styles.primary} disabled={busy}>Assign next reviewer</button>
          </form> : <p>Grant another reviewer active coverage for this store to reassign the case.</p>)}
        </article>;
      })}
    </>}
  </section>;
}

