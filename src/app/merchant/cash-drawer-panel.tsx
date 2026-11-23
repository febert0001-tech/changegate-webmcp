"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CashDrawerView } from "../../merchant-team/cash-drawers";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { canReview, money } from "../../merchant-team/refund-requests";
import styles from "./merchant.module.css";

const amount = (value: FormDataEntryValue | null) => Math.round(Number(value) * 100);
const stamp = (at: string) => new Date(at).toLocaleString();
const entryLabels = { sale: "Cash sale", payout: "Staff-reported cash payout", addition: "Cash added", removal: "Cash removed" };

function CashAmount({ label, required = true, min = 0 }: { label: string; required?: boolean; min?: number }) {
  return <label>{label}<input name="amount" type="number" inputMode="decimal" min={min} max="9999999999.99"
    step="0.01" required={required} /></label>;
}

export function CashDrawerPanel({ id, session, send, onSessionError }: {
  id?: string;
  session: TeamSession;
  send: <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
  onSessionError: (error: unknown) => boolean;
}) {
  const [view, setView] = useState<CashDrawerView>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const submissions = useRef<Partial<Record<"openCashDrawer" | "recordDrawerMovement" | "recordDrawerFollowUp", string>>>({});
  const { sessionVersion, demoShift, demoRegister } = session;
  const drawer = view?.drawer;
  const report = drawer?.report;

  function submissionId(kind: keyof typeof submissions.current) {
    return submissions.current[kind] ??= crypto.randomUUID();
  }

  useEffect(() => {
    if (!demoShift) return;
    const controller = new AbortController();
    void send<CashDrawerView>({ action: "cashDrawers", ...(id && { id }) }, { sessionVersion, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setView(result); })
      .catch(error => {
        if (!controller.signal.aborted && !onSessionError(error)) setNotice("The drawer close could not be opened.");
      });
    return () => controller.abort();
  }, [demoShift, id, sessionVersion, send, onSessionError]);

  async function save(command: TeamCommand, form?: HTMLFormElement) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = await send<CashDrawerView>(command, { sessionVersion });
      setView(result);
      form?.reset();
      if (command.action === "openCashDrawer" || command.action === "recordDrawerMovement" || command.action === "recordDrawerFollowUp")
        delete submissions.current[command.action];
      if (command.action === "openCashDrawer" && result.drawer) {
        window.history.replaceState(null, "", `/cash-drawer?id=${result.drawer.id}`);
      }
    } catch (error) {
      if (!onSessionError(error)) setNotice("The drawer update could not be saved. Reopen the drawer and check its status before retrying.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, makeCommand: (data: FormData) => TeamCommand) {
    event.preventDefault();
    void save(makeCommand(new FormData(event.currentTarget)), event.currentTarget);
  }

  return <section className={`${styles.card} ${styles.shiftOverview}`} aria-labelledby="drawer-heading">
    <div className={styles.screenHeading}>
      <div><h2 id="drawer-heading">Close cash drawer</h2><p className={styles.fieldHint}>Fictional shift · USD</p></div>
      <Link href="/shift-overview" prefetch={false}>Back to Shift Overview</Link>
    </div>
    {notice && <p role="alert" className={styles.formError}>{notice}</p>}
    {!demoShift && <p>Drawer reconciliation is unavailable in this workspace.</p>}
    {!view && demoShift && !notice && <p role="status">Loading drawer records…</p>}
    {view && !drawer && <p className={styles.emptyState}>Close incomplete. The opening float and first closing count are missing.</p>}
    {view && demoRegister && !view.activeId && <form className={styles.formRow} onSubmit={event =>
      submit(event, data => ({ action: "openCashDrawer", id: submissionId("openCashDrawer"), cents: amount(data.get("amount")) }))}>
      <CashAmount label={drawer ? "Next shift opening float" : "Opening float"} />
      <button className={styles.primary} disabled={busy}>Save opening float</button>
    </form>}
    {view?.activeId && view.activeId !== drawer?.id && <Link href={`/cash-drawer?id=${view.activeId}`} prefetch={false}>Open current drawer</Link>}
    {drawer && <div className={styles.shiftOverview}>
      <div>
        <h3>{drawer.location} · {drawer.register}</h3>
        <p className={styles.fieldHint}>Shift opened <time dateTime={drawer.openedAt}>{stamp(drawer.openedAt)}</time></p>
      </div>
      {!report ? <>
        <p className={styles.emptyState}>Close incomplete. Save the first closing count to reveal expected cash.</p>
        {demoRegister && <>
          <div className={styles.actions}><Link href="/demo-sales" prefetch={false}>Record sale</Link><Link href="/transactions" prefetch={false}>Transactions</Link></div>
          <details>
            <summary>Record a cash addition or removal</summary>
            <form className={styles.formRow} onSubmit={event => submit(event, data => ({
              action: "recordDrawerMovement", id: drawer.id, entryId: submissionId("recordDrawerMovement"),
              kind: data.get("kind") === "removal" ? "removal" : "addition", cents: amount(data.get("amount")), note: String(data.get("note")),
            }))}>
              <label>Movement<select name="kind"><option value="addition">Cash addition</option><option value="removal">Cash removal</option></select></label>
              <CashAmount label="Movement amount" min={0.01} />
              <label>Reason<input name="note" maxLength={240} required /></label>
              <button disabled={busy}>Save movement</button>
            </form>
          </details>
          <form className={styles.formRow} onSubmit={event => submit(event, data => ({
            action: "closeCashDrawer", id: drawer.id, cents: amount(data.get("amount")),
          }))}>
            <CashAmount label="First closing count" />
            <button className={styles.primary} disabled={busy}>Save first count</button>
          </form>
        </>}
      </> : <>
        <dl className={styles.facts}>
          <div><dt>Expected cash</dt><dd>{money(report.expected)}</dd></div>
          <div><dt>Counted cash</dt><dd>{money(report.firstCount.cents)}</dd></div>
          <div><dt>Variance</dt><dd>{report.variance === 0 ? "Balanced" :
            `${money(Math.abs(report.variance))} ${report.variance < 0 ? "short" : "over"}`}</dd></div>
        </dl>
        <p>First count by {report.firstCount.actor} · <time dateTime={report.firstCount.at}>{stamp(report.firstCount.at)}</time></p>
        {report.variance !== 0 && <div className={styles.actions}>
          <strong>Discrepancy requiring review</strong>
          {report.caseId ? <Link href={`/merchant/${report.caseId}`} prefetch={false}>Open review case</Link>
            : canReview(session.role) && <button disabled={busy} onClick={() => void save({ action: "openDrawerCase", id: drawer.id })}>Open variance review case</button>}
        </div>}
        <section aria-label="Cash entries">
          <h3>Cash entries</h3>
          <ul className={styles.shiftRecords}>
            <li><div><strong>Opening float · {money(drawer.opening.cents)}</strong><span>{drawer.opening.actor}</span></div></li>
            {report.entries.map(entry => <li key={entry.kind + entry.id}>
              <div><strong>{entryLabels[entry.kind]} · {money(entry.cents)}</strong><span>{entry.actor} · {stamp(entry.at)}</span></div>
              {entry.kind === "sale" && <Link href={`/demo-sales/${entry.id}`} prefetch={false}>Open cash sale</Link>}
              {entry.kind === "payout" && <Link href={`/transactions/${entry.id}/receipt`} prefetch={false}>Open cash payout receipt</Link>}
              {entry.note && <p>{entry.note}</p>}
            </li>)}
          </ul>
        </section>
        <section aria-label="Recounts and explanations">
          <h3>Recounts and explanations</h3>
          {report.followUps.length > 0 && <ul className={styles.shiftRecords}>{report.followUps.map(entry => <li key={entry.id}>
            <div><strong>{entry.cents === null ? "Explanation" : `Recount · ${money(entry.cents)}`}</strong>
              <span>{entry.actor} · {stamp(entry.at)}</span></div><p>{entry.note}</p>
          </li>)}</ul>}
          <form className={styles.formRow} onSubmit={event => submit(event, data => ({
            action: "recordDrawerFollowUp", id: drawer.id, entryId: submissionId("recordDrawerFollowUp"),
            cents: data.get("amount") === "" ? null : amount(data.get("amount")), note: String(data.get("note")),
          }))}>
            <CashAmount label="Recount (optional)" required={false} />
            <label>Explanation<input name="note" maxLength={240} required /></label>
            <button disabled={busy}>Save follow-up</button>
          </form>
        </section>
      </>}
    </div>}
    {view && view.drawers.length > 1 && <details>
      <summary>Drawer shift history</summary>
      <ul className={styles.shiftRecords}>{view.drawers.map(item => <li key={item.id}>
        <Link href={`/cash-drawer?id=${item.id}`} prefetch={false}>{item.location} · {item.register} · {stamp(item.openedAt)} · {item.isClosed ? "Closed" : "Open"}</Link>
      </li>)}</ul>
    </details>}
  </section>;
}
