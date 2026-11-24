"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { activeStatuses, type TeamCaseDetail, type TeamCommand, type TeamSession, type TeamWorkspaceView } from "../../merchant-team/contracts";
import styles from "./merchant.module.css";
import { StoreEntry } from "./store-entry";
import { TransactionWorkspace } from "../transactions/transaction-workspace";
import { ShiftOverviewPanel } from "./shift-overview-panel";
import { CashDrawerPanel } from "./cash-drawer-panel";
import { DemoInviteAdmin } from "./demo-invite-panel";
import { PilotReviewPanel } from "./pilot-review-panel";
import { CoverageSettings } from "./coverage-settings";
import { OvernightOwnerPanel, OvernightReviewer } from "./overnight-panel";
import { canReview } from "../../merchant-team/refund-requests";
import { WeeklyCashReviewPanel } from "./weekly-cash-review-panel";
import { drawerDispositions } from "../../merchant-team/weekly-cash-review";
import { DemoSalesPanel } from "./demo-sales-panel";
import { DiscountSalesPanel } from "./discount-sales-panel";
import type { TransactionStep } from "../../merchant-team/refund-requests";
import { ReviewSummaryPanel } from "./review-summary-panel";
import { RefundImportPanel } from "./refund-import-panel";
import { EvidenceRows, findingTitle } from "./refund-evidence";
import { formatUsd } from "../../merchant-team/refund-comparison";

const errors: Record<string, string> = {
  COVERAGE_CASE_CHANGED: "The case changed. Refresh the handoff before assigning a reviewer.",
  COVERAGE_REASSIGN_UNAVAILABLE: "Choose another reviewer with active coverage for this store.",
  PILOT_NOT_FOUND: "This pilot review is unavailable in your merchant workspace.",
  PILOT_ROLE_REQUIRED: "A merchant owner or manager can review a pilot.",
  PILOT_SYNTHETIC_ONLY: "Use fictional exports in the online demo.",
  PILOT_INVALID_WEEK: "Select a completed seven-day week and a valid store time zone.",
  PILOT_SOURCE_CHANGED: "This source already has saved evidence. Reimport the same CSV and column mapping.",
  PILOT_NEEDS_BOTH: "Attach both exports before comparing the week.",
  PILOT_CASE_CHANGED: "Someone updated this issue. Reopen the pilot to see the latest decision.",
  PILOT_BASELINE_EMPTY: "Record active minutes or the exceptions your staff measured.",
  PILOT_BASELINE_RECORDED: "The original baseline is already saved.",
  PILOT_SOURCE_REFERENCE: "Use an exact refund reference from the attached exports.",
  COVERAGE_DENIED: "You do not have access to this overnight case or queue.",
  COVERAGE_EXPIRED: "You have no active coverage for this shift.",
  COVERAGE_INVALID_WINDOW: "Enter a valid Atlanta-time window with an end in the future.",
  COVERAGE_GRANT_CONFLICT: "An overlapping grant already covers this reviewer and store.",
  COVERAGE_ALREADY_CLAIMED: "Another reviewer has claimed this case.",
  COVERAGE_CLAIM_REQUIRED: "Claim the case before asking the owner a question.",
  COVERAGE_REPLY_PENDING: "The current question is awaiting an owner reply.",
  COVERAGE_ALREADY_ANSWERED: "This question has already been answered.",
  DRAWER_DISPOSITION_REQUIRED: "Choose how the drawer discrepancy was resolved.",
  DRAWER_RECOUNT_MISMATCH: "Record a recount that matches expected cash before choosing that disposition.",
  SIGN_IN_FAILED: "Check your username and password.",
  SIGN_IN_LIMIT: "Too many sign-in attempts. Try again in a few minutes.",
  SIGN_IN_RECOVERY_REQUIRED: "This browser kept an old session cookie. Re-enter your password to recover sign-in.",
  SIGN_IN_REQUIRED: "Your session has ended. Sign in again.",
  SESSION_CHANGED: "The signed-in employee changed. Reload this page before making updates.",
  DEMO_SHIFT_STARTED: "A demo shift is already running. Use Replay this seed to start it over.",
  DEMO_SHIFT_CHANGED: "The demo event changed. Wait for the current event to refresh.",
  DEMO_REFUND_REQUIRED: "Have the assigned cashier submit this refund before advancing the clock.",
  DEMO_SHIFT_UNAVAILABLE: "The synthetic shift is unavailable in this workspace.",
  DISCOUNT_BELOW_DEMO_LIMIT: "Enter a discount of at least $25 to start this review demo.",
  DISCOUNT_INVALID: "Enter a discount below the original subtotal.",
  DISCOUNT_TERMS_CHANGED: "The terms changed. Review the latest proposal before acting.",
  DISCOUNT_DECISION_REQUIRED: "Wait for a supervisor decision before finishing this sale.",
  DISCOUNT_CASH_DRAWER_REQUIRED: "Open the Harbor Bar cash drawer before finishing a cash sale.",
  CASE_NOT_FOUND: "This case could not be opened in your workspace.",
  CASE_CHANGED: "Someone updated this case. Reload to see the latest version before saving.",
  CASE_RESOLVED: "This case is already resolved. Reload to see its history.",
  ASSIGNEE_UNAVAILABLE: "Select an employee from your merchant workspace.",
  FINDING_REQUIRED: "Record a finding and next action before resolving this case.",
  INVALID_COMMAND: "Check the required fields and try again.",
  IMPORT_NOT_FOUND: "This import is unavailable in your workspace.",
  DISPOSITION_CHANGED: "A coworker updated this disposition. Reload the summary before saving again.",
  ALERT_DEVICE_IN_USE: "This device belongs to another supervisor. Unsubscribe from that account first.",
  ALERTS_UNAVAILABLE: "Device delivery is currently unavailable.",
  TRANSACTION_CONFIRMATION_FAILED: "Confirm the decision with your supervisor password.",
  TRANSACTION_ROLE_REQUIRED: "This action requires a manager or owner.",
  TRANSACTION_SELF_REVIEW: "Another manager must review this employee’s request.",
  TRANSACTION_ACTION_UNAVAILABLE: "This transaction cannot take that action.",
  TRANSACTION_NOT_FOUND: "This transaction is unavailable in your workspace.",
  TRANSACTION_SUBMISSION_CHANGED: "This form was already submitted. Open the original transaction.",
  TRANSACTION_DECIDED: "A decision already exists. Reload the transaction.",
  SQUARE_NOT_CONNECTED: "Square Sandbox is not configured for this store.",
  SQUARE_SALE_UNAVAILABLE: "Square could not verify a completed USD card payment for this store and location.",
  SQUARE_SCOPE_MISMATCH: "Square Sandbox credentials do not match the configured store.",
  SQUARE_PROVIDER_UNAVAILABLE: "Square did not return enough information to confirm the sale or its refundable balance. Try again.",
  SQUARE_SALE_INELIGIBLE: "The Square sale is outside its refund window or has reached its refund limit.",
  SQUARE_PRIOR_REFUND_FAILED: "Square blocks additional refunds because an earlier refund failed on this payment.",
  SQUARE_RECONCILIATION_REQUIRED: "The retry window ended. Reconcile the original attempt in Square before taking further action.",
  PAYPAL_NOT_CONNECTED: "PayPal not connected",
  PAYPAL_CAPTURE_UNAVAILABLE: "PayPal could not verify a USD capture owned by this store.",
  PAYPAL_HISTORY_UNAVAILABLE: "PayPal’s capture or refund history is incomplete. Refunds are blocked until it can be reconciled.",
  PAYPAL_PROVIDER_UNAVAILABLE: "PayPal Sandbox is unavailable. Try the lookup again.",
  PAYPAL_REFUNDS_DISABLED: "PayPal Sandbox is connected for lookup. Refund submissions are disabled.",
  PAYPAL_BALANCE_CHANGED: "The refundable balance changed. Recheck the PayPal capture before starting a new request.",
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

export function MerchantConsole({ caseId, imports, importId, reviewSummary, transaction, overview, demoSale, discountSale, cashDrawer, cashDrawerRegister, cashWeek, overnight, pilot, inviteAdmin }: {
  caseId?: string; imports?: boolean; importId?: string; reviewSummary?: boolean; overview?: boolean;
  transaction?: { id: string; step: TransactionStep } | "list";
  demoSale?: string | true;
  discountSale?: boolean;
  cashDrawer?: string | true;
  cashDrawerRegister?: "harbor-bar";
  cashWeek?: { week?: string; location?: string };
  overnight?: string | true;
  pilot?: string | true;
  inviteAdmin?: boolean;
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
  if(!ready)return <main className={styles.shell}><p role="status">Loading workspace…</p></main>;
  if(!session)return <StoreEntry>
    <form className={styles.entrySide} method="post" onSubmit={(event) => {
        const data = formValues(event);
        event.currentTarget.reset();
        void run(async () => {
          await send<TeamSession>({ action: "signIn", username: field(data, "username").trim().toLowerCase(),
            password: field(data, "password"), ...(recoverSession && { recoverSession: true as const }) });
          notifySessionChange();
          window.location.reload();
        });
      }}>
        <h2>Sign in to your store</h2>
        {!!notice && <p className={styles.formError} role="alert">{notice}</p>}
        <label>Username<input name="username" autoComplete="username" maxLength={64} required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={160} required /></label>
        <button className={styles.primary} disabled={busy}>{recoverSession ? "Recover sign-in" : "Sign in"}</button>
        <p className={styles.fieldHint}>Need access or a password reset? Contact your store administrator.</p>
      </form>
  </StoreEntry>;
  if (session.role === "reviewer") return <main className={styles.shell}>
    <header className={styles.header}>
      <div><p className={styles.brand}>ChangeGate</p><h1>{session.merchantName}</h1></div>
      <div className={styles.profile}><span>{session.name}</span>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await send<null>({ action: "signOut" }, { sessionVersion: session.sessionVersion });
          setWorkspace(null);
          notifySessionChange();
        })}>Sign out</button>
      </div>
    </header>
    {notice && <p role="alert">{notice}</p>}
    <OvernightReviewer key={String(overnight)} {...(typeof overnight === "string" && { id: overnight })}
      session={session} send={send} onSessionError={clearOnSessionError} />
  </main>;
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div>
        <p className={styles.brand}>ChangeGate</p>
        <h1>{session?.merchantName ?? "Merchant workspace"}</h1>
      </div>
      {session && <div className={styles.profile}>
        {session.demoShift && <Link href="/shift-overview" prefetch={false} aria-current={overview ? "page" : undefined}>Shift Overview</Link>}
        {session.demoShift && <Link href="/verified-square-example" prefetch={false}>View verified Square Sandbox example</Link>}
        {session.demoInviteAdmin && !inviteAdmin && <Link href="/demo-access" prefetch={false}>Create demo invite</Link>}
        {session.pilotEnabled && !pilot && <Link href="/pilot-review" prefetch={false}>Start pilot review</Link>}
        <Link href="/transactions" prefetch={false}>Transactions</Link>
        {(session.demoRegister || session.demoDiscountEnabled) &&
          <Link href={session.demoRegister ? "/demo-sales" : "/demo-sales?discount=1"} prefetch={false}>
            {session.demoRegister ? "Record sale" : "Discount approvals"}</Link>}
        {transaction && <Link href="/merchant" prefetch={false}>Reconciliation</Link>}
        {(imports || caseId) && <Link href="/merchant" prefetch={false}>Work queue</Link>}
        <span>{session.name}</span>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await send<null>({ action: "signOut" }, { sessionVersion: session.sessionVersion });
          setWorkspace(null);
          notifySessionChange();
          router.replace(overview ? "/shift-overview" : transaction ? "/transactions" : "/merchant");
          router.refresh();
        })}>Sign out</button>
      </div>}
    </header>
    {(notice || busy) && <p className={styles.inlineNotice} role="status">{notice || "Working…"}</p>}
    {overview && session.demoShift && canReview(session.role) && <>
      <OvernightOwnerPanel key={session.sessionVersion} session={session} send={send} onSessionError={clearOnSessionError} />
      <CoverageSettings key={session.sessionVersion} session={session} send={send} onSessionError={clearOnSessionError} />
    </>}
    {inviteAdmin ? (session.demoInviteAdmin ? <DemoInviteAdmin key={session.sessionVersion}
      requireIdentity={Boolean(session.demoInviteIdentityRequired)} /> :
      <section className={styles.card}><h2>Demo invitations</h2><p>A demo administrator manages invites.</p></section>) : pilot ? <PilotReviewPanel key={String(pilot)} session={session} send={send} onSessionError={clearOnSessionError}
      {...(typeof pilot === "string" && { id: pilot })} /> : overnight ? <section className={styles.card}><h2>Overnight review desk</h2>
      <p>Sign in with your assigned reviewer account to open the desk.</p></section> : cashWeek ? (
      <WeeklyCashReviewPanel key={session.sessionVersion} initial={cashWeek} session={session} send={send} onSessionError={clearOnSessionError} />
    ) : cashDrawer ? (
      <CashDrawerPanel key={session.sessionVersion + (cashDrawerRegister ?? "")} {...(typeof cashDrawer === "string" && { id: cashDrawer })}
        {...(cashDrawerRegister && { register: cashDrawerRegister })}
        session={session} send={send} onSessionError={clearOnSessionError} />
    ) : overview ? (
      <ShiftOverviewPanel key={session.sessionVersion} session={session} send={send} onSessionError={clearOnSessionError} />
    ) : demoSale && discountSale ? (
      <DiscountSalesPanel key={versionKey(session.sessionVersion, typeof demoSale === "string" ? demoSale : undefined)}
        {...(typeof demoSale === "string" && { reference: demoSale })} session={session} send={send} onSessionError={clearOnSessionError} />
    ) : demoSale ? (
      <DemoSalesPanel key={versionKey(session.sessionVersion, typeof demoSale === "string" ? demoSale : undefined)}
        {...(typeof demoSale === "string" && { reference: demoSale })}
        session={session} send={send} onSessionError={clearOnSessionError} />
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
          <h2 id="case-heading">{detail.drawerId ? "Cash drawer discrepancy" :
            detail.evidence ? findingTitle(detail.evidence.finding) : "Refund case"}</h2>
          {detail.drawerId && <Link href={`/cash-drawer?id=${detail.drawerId}`} prefetch={false}>Open drawer close</Link>}
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
          {item.status !== "Resolved" && (!detail.drawerId || session.role === "manager" || session.role === "owner") && (
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
              {canResolve && detail.drawerId && <label>Drawer disposition
                <select name="drawerDisposition" defaultValue="">
                  <option value="" disabled>Select a disposition</option>
                  {drawerDispositions.map(option => <option key={option}>{option}</option>)}
                </select>
              </label>}
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
                const drawerDisposition = drawerDispositions.find(option => option === value("drawerDisposition"));
                if (detail.drawerId && !drawerDisposition) { setNotice(errors.DRAWER_DISPOSITION_REQUIRED!); return; }
                change({ action: "resolve", id: item.id, revision: item.revision,
                  ...(drawerDisposition && { drawerDisposition }) }, "Case resolved.");
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
