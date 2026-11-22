"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { activeStatuses, type TeamCaseDetail, type TeamCommand, type TeamSession, type TeamWorkspaceView } from "../../merchant-team/contracts";
import styles from "./merchant.module.css";
import { TransactionWorkspace } from "../transactions/transaction-workspace";
import type { TransactionStep } from "../../merchant-team/refund-requests";
import { ReviewSummaryPanel } from "./review-summary-panel";
import { RefundImportPanel } from "./refund-import-panel";
import { EvidenceRows, findingTitle } from "./refund-evidence";
import { formatUsd } from "../../merchant-team/refund-comparison";

const errors: Record<string, string> = {
  SIGN_IN_FAILED: "Check your username and password.",
  SIGN_IN_LIMIT: "Too many sign-in attempts. Try again in a few minutes.",
  SIGN_IN_RECOVERY_REQUIRED: "This browser kept an old session cookie. Re-enter your password to recover sign-in.",
  SIGN_IN_REQUIRED: "Your session has ended. Sign in again.",
  SESSION_CHANGED: "The signed-in employee changed. Reload this page before making updates.",
  CASE_NOT_FOUND: "This case could not be opened in your workspace.",
  CASE_CHANGED: "Someone updated this case. Reload to see the latest version before saving.",
  CASE_RESOLVED: "This case is already resolved. Reload to see its history.",
  ASSIGNEE_UNAVAILABLE: "Select an employee from your merchant workspace.",
  FINDING_REQUIRED: "Record a finding and next action before resolving this case.",
  INVALID_COMMAND: "Check the required fields and try again.",
  IMPORT_NOT_FOUND: "This import is unavailable in your workspace.",
  DISPOSITION_CHANGED: "A coworker updated this disposition. Reload the summary before saving again.",
  TRANSACTION_CONFIRMATION_FAILED: "Confirm the decision with your supervisor password.",
  TRANSACTION_ROLE_REQUIRED: "This action requires a manager or owner.",
  TRANSACTION_SELF_REVIEW: "Another manager must review this employee’s request.",
  TRANSACTION_ACTION_UNAVAILABLE: "This transaction cannot take that action.",
  TRANSACTION_NOT_FOUND: "This transaction is unavailable in your workspace.",
  TRANSACTION_SUBMISSION_CHANGED: "This form was already submitted. Open the original transaction.",
  TRANSACTION_DECIDED: "A decision already exists. Reload the transaction.",
  FINDING_NOT_FOUND: "This finding is unavailable in your workspace.",
  CSV_TOO_LARGE: "Choose a file no larger than 96 KiB.",
  CSV_ENCODING: "Save the CSV as UTF-8 and try again.",
  CSV_EMPTY: "Include a header with at least three columns and at least one refund row.",
  CSV_LIMIT: "A CSV can contain at most 1,000 source rows and 48 columns.",
  CSV_QUOTING: "The CSV has invalid quoting. Fix the quotation marks or export it again.",
  CSV_MAPPING: "Select a different column for each mapped field.",
  CSV_NO_ACCEPTED_ROWS: "Correct the rejected rows before importing.",
  REQUEST_TOO_LARGE: "The request exceeds the import size limit.",
  WORKSPACE_NOT_CONFIGURED: "This workspace has not been configured on the server.",
};

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function send<T>(command: TeamCommand, { signal, sessionVersion }: { signal?: AbortSignal; sessionVersion?: string } = {}): Promise<T> {
  const response = await fetch("/api/merchant", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(sessionVersion && { "X-ChangeGate-Session": sessionVersion }) },
    body: JSON.stringify(command), signal: signal ?? null,
  });
  if (!response.ok) {
    const { error } = await response.json() as { error: string };
    throw new RequestError(response.status, error, errors[error] ?? "The workspace is temporarily unavailable.");
  }
  return response.json() as Promise<T>;
}

function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}
const field = (data: FormData, key: string) => String(data.get(key) ?? "");
const errorText = (error: unknown) => error instanceof RequestError ? error.message : "Could not connect to the workspace.";
const versionKey = (version: string, id?: string) => version + ":" + (id ?? "");
const timeText = (time: string) => time.replace("T", " ").slice(0, 19) + " UTC";
const sessionChannel = "changegate-merchant-session";

function notifySessionChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(sessionChannel);
  channel.postMessage("changed");
  channel.close();
}

export function MerchantConsole({ caseId, imports, importId, reviewSummary, transaction }: {
  caseId?: string; imports?: boolean; importId?: string; reviewSummary?: boolean;
  transaction?: { id: string; step: TransactionStep } | "list";
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [recoverSession, setRecoverSession] = useState(false);
  const [workspace, setWorkspace] = useState<TeamWorkspaceView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"Needs attention" | "Assigned to me" | "Resolved">("Needs attention");
  const session = workspace?.session;
  const cases = workspace?.cases ?? [];
  const detail = workspace?.detail;
  const item = detail?.case;
  const canResolve = Boolean(item?.finding && item.nextAction);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(sessionChannel);
    channel.onmessage = () => window.location.reload();
    return () => channel.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const view = await send<TeamWorkspaceView>({ action: "workspace", id: caseId }, { signal: controller.signal });
        if (!controller.signal.aborted) setWorkspace(view);
      } catch (error) {
        if (controller.signal.aborted) return;
        setWorkspace(null);
        if (!(error instanceof RequestError && error.status === 401)) setNotice(errorText(error));
      } finally {
        if (!controller.signal.aborted) setReady(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [caseId]);

  const clearOnSessionError = useCallback((error: unknown) => {
    if (!(error instanceof RequestError) || (error.status !== 401 && error.code !== "SESSION_CHANGED")) return false;
    setWorkspace(null);
    setNotice(errorText(error));
    return true;
  }, []);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (error instanceof RequestError && (error.status === 401 || error.code === "SESSION_CHANGED")) {
        setWorkspace(null);
      }
      setRecoverSession(error instanceof RequestError && error.code === "SIGN_IN_RECOVERY_REQUIRED");
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function change(command: Extract<TeamCommand, { action: "record" | "assign" | "note" | "resolve" }>,
    message: string, onSaved?: () => void) {
    if (!session) return;
    const { sessionVersion } = session;
    void run(async () => {
      const saved = await send<TeamCaseDetail>(command, { sessionVersion });
      setWorkspace((current) => current?.session.sessionVersion === sessionVersion ? {
        ...current,
        detail: saved,
        cases: [saved.case, ...current.cases.filter(({ id }) => id !== saved.case.id)],
      } : current);
      onSaved?.();
      setNotice(message);
    });
  }

  const visible = cases.filter(row => filter === "Resolved" ? row.status === "Resolved" :
    row.status !== "Resolved" && (filter !== "Assigned to me" || row.assignee === session?.username));
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div>
        <p className={styles.brand}>ChangeGate</p>
        <h1>{session?.merchantName ?? "Merchant workspace"}</h1>
      </div>
      {session && <div className={styles.profile}>
        <Link href="/transactions" prefetch={false}>Transactions</Link>
        {transaction && <Link href="/merchant" prefetch={false}>Reconciliation</Link>}
        {(imports || caseId) && <Link href="/merchant" prefetch={false}>Work queue</Link>}
        <span>{session.name}</span>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await send<null>({ action: "signOut" }, { sessionVersion: session.sessionVersion });
          setWorkspace(null);
          notifySessionChange();
          router.replace(transaction ? "/transactions" : "/merchant");
          router.refresh();
        })}>Sign out</button>
      </div>}
    </header>
    {(notice || busy) && <p className={styles.inlineNotice} role="status">{notice || "Working…"}</p>}
    {!ready || (busy && !session) ? <p>Loading workspace…</p> : !session ? (
      <form className={styles.signIn} method="post" onSubmit={(event) => {
        const data = formValues(event);
        event.currentTarget.reset();
        void run(async () => {
          await send<TeamSession>({ action: "signIn", username: field(data, "username").trim().toLowerCase(),
            password: field(data, "password"), ...(recoverSession && { recoverSession: true as const }) });
          notifySessionChange();
          window.location.reload();
        });
      }}>
        <h2>Employee sign-in</h2>
        <label>Username<input name="username" autoComplete="username" maxLength={64} required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={160} required /></label>
        <button className={styles.primary} disabled={busy}>{recoverSession ? "Recover sign-in" : "Sign in"}</button>
      </form>
    ) : transaction ? (
      <TransactionWorkspace key={versionKey(session.sessionVersion, transaction === "list" ? undefined : transaction.id)}
        destination={transaction} session={session} send={send} onSessionError={clearOnSessionError} />
    ) : reviewSummary && importId ? (
      <ReviewSummaryPanel key={versionKey(session.sessionVersion, importId)} send={send} session={session}
        importId={importId} onSessionError={clearOnSessionError} />
    ) : imports ? (
      <RefundImportPanel key={versionKey(session.sessionVersion, importId)} send={send} session={session}
        {...(importId && { importId })} onSessionError={clearOnSessionError} />
    ) : (
      !caseId ? <section className={styles.card} aria-labelledby="queue-heading">
        <div className={styles.screenHeading}>
          <h2 id="queue-heading">Work queue</h2>
          <Link className={styles.primary} href="/merchant/imports" prefetch={false}>Import refunds</Link>
        </div>
        <div className={styles.filters} aria-label="Queue filter">
          {(["Needs attention", "Assigned to me", "Resolved"] as const).map(label =>
            <button type="button" key={label} aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}</button>)}
        </div>
        {visible.length ? <ul className={styles.queue} aria-label="Cases">{visible.map(row =>
          <li key={row.id}>
            <Link className={styles.queueCase} href={`/merchant/${row.id}`} prefetch={false}>
              <div>
                <strong>{row.differenceCents === undefined ? row.finding || row.reference :
                  "Refund amounts differ by " + formatUsd(row.differenceCents)}</strong>
                {(row.finding || row.differenceCents !== undefined) && <span>{row.reference}</span>}
              </div>
              <div><span>Assignee</span>{row.assigneeName}</div>
              <div><span>Status</span>{row.status}</div>
            </Link>
          </li>)}</ul> : <p className={styles.emptyState}>{filter === "Assigned to me" ? "No open cases are assigned to you." :
          filter === "Resolved" ? "No resolved cases yet." : "No cases need attention. Import refunds to look for findings."}</p>}
        <details className={styles.newCase}>
          <summary>Open a case manually</summary>
          <form onSubmit={(event) => {
            const data = formValues(event);
            void run(async () => {
              const saved = await send<TeamCaseDetail>({ action: "create", reference: field(data, "reference") },
                { sessionVersion: session.sessionVersion });
              router.push(`/merchant/${saved.case.id}`);
            });
          }}>
            <label>Refund or ticket reference<input name="reference" maxLength={160} required /></label>
            <button disabled={busy}>Open case</button>
          </form>
        </details>
      </section> : <section className={styles.card} aria-labelledby="case-heading">
        {!item || !detail ? <>
          <h2 id="case-heading">Case unavailable</h2>
          <p className={styles.fieldHint}>This case could not be opened in your workspace.</p>
        </> : <>
          <p className={styles.caseReference}>{item.reference}</p>
          <h2 id="case-heading">{detail.evidence ? findingTitle(detail.evidence.finding) : "Refund case"}</h2>
          {item.finding && <p className={styles.findingSummary}>{item.finding}</p>}
          <dl className={styles.facts}>
            <div><dt>Assignee</dt><dd>{item.assigneeName}</dd></div>
            <div><dt>Status</dt><dd>{item.status}</dd></div>
            <div><dt>Next action</dt><dd>{item.nextAction || "Add a next action."}</dd></div>
          </dl>
          {detail.evidence && <section className={styles.importSection} aria-labelledby="import-evidence">
            <h3 id="import-evidence">Source evidence</h3>
            {item.finding !== detail.evidence.finding.explanation && <p>{detail.evidence.finding.explanation}</p>}
            <EvidenceRows rows={detail.evidence.finding.rows} {...(detail.evidence.comparison && { files: detail.evidence.comparison.files })} />
            <Link href={`/merchant/imports/${detail.evidence.importId}`} prefetch={false}>Open source import</Link>
          </section>}
          {item.status !== "Resolved" && (
            <fieldset key={item.id} className={styles.editors} disabled={busy}>
              <legend className={styles.visuallyHidden}>Case updates</legend>
              <details className={styles.caseEdit} open={!canResolve}>
                <summary>Edit finding or assignment</summary>
                <form key={JSON.stringify([item.finding, item.nextAction, item.status])} onSubmit={event => {
                  const data = formValues(event);
                  change({ action: "record", id: item.id, revision: item.revision, finding: field(data, "finding"),
                    nextAction: field(data, "nextAction"), status: field(data, "status") === "Awaiting evidence" ?
                      "Awaiting evidence" : "Investigating" }, "Finding saved.");
                }}>
                  <label>Finding<textarea name="finding" defaultValue={item.finding} maxLength={1200} required /></label>
                  <label>Next action<textarea name="nextAction" defaultValue={item.nextAction} maxLength={1200} required /></label>
                  <div className={styles.formRow}>
                    <label>Case status<select name="status" defaultValue={item.status}>
                      {activeStatuses.map(label => <option key={label}>{label}</option>)}
                    </select></label>
                    <button className={!canResolve ? styles.primary : undefined}>Save finding</button>
                  </div>
                </form>
                <form key={item.assignee} className={styles.formRow} onSubmit={event => {
                  const data = formValues(event);
                  change({ action: "assign", id: item.id, revision: item.revision, assignee: field(data, "assignee") }, "Assignment saved.");
                }}>
                  <label>Assign to<select name="assignee" defaultValue={session.coworkers.some(({ username }) => username === item.assignee) ? item.assignee : ""} required>
                    <option value="" disabled>Select an employee</option>
                    {session.coworkers.map(({ username, name }) => <option key={username} value={username}>{name}</option>)}
                  </select></label>
                  <button>Assign case</button>
                </form>
              </details>
              <details className={styles.caseEdit}>
                <summary>Add a note</summary>
                <form onSubmit={event => {
                  const form = event.currentTarget;
                  const data = formValues(event);
                  change({ action: "note", id: item.id, revision: item.revision, note: field(data, "note") },
                    "Note saved.", () => form.reset());
                }}>
                  <label>Case note<textarea name="note" maxLength={1600} required /></label>
                  <button>Add note</button>
                </form>
              </details>
              {canResolve && <button type="button" className={styles.primary} onClick={event => {
                const controls = event.currentTarget.closest("fieldset")?.elements;
                const value = (name: string) => {
                  const control = controls?.namedItem(name);
                  return control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement ? control.value : "";
                };
                if (value("finding") !== item.finding || value("nextAction") !== item.nextAction ||
                    value("status") !== item.status || (value("assignee") && value("assignee") !== item.assignee) || value("note").trim()) {
                  setNotice("Save your edits or restore the saved values before resolving.");
                  return;
                }
                change({ action: "resolve", id: item.id, revision: item.revision }, "Case resolved.");
              }}>Resolve case</button>}
            </fieldset>
          )}
          <section className={styles.history} aria-labelledby="history-heading">
            <h3 id="history-heading">Case history</h3>
            <ol>{detail.history.map(event => <li key={event.sequence}>
              <div><strong>{event.kind}</strong><span>{event.actor} · <time dateTime={event.occurredAt}>{timeText(event.occurredAt)}</time></span></div>
              <p>{event.detail}</p>
            </li>)}</ol>
          </section>
          </>}
        </section>
    )}
  </main>;
}
