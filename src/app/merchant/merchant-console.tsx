"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { activeStatuses, type TeamCaseDetail, type TeamCommand, type TeamSession, type TeamWorkspaceView } from "../../merchant-team/contracts";
import styles from "./merchant.module.css";

const errors: Record<string, string> = {
  SIGN_IN_FAILED: "Check your username and password.",
  SIGN_IN_REQUIRED: "Your session has ended. Sign in again.",
  SESSION_CHANGED: "The signed-in employee changed. Reload this page before making updates.",
  CASE_NOT_FOUND: "This case could not be opened in your workspace.",
  CASE_CHANGED: "Someone updated this case. Reload to see the latest version before saving.",
  CASE_RESOLVED: "This case is already resolved. Reload to see its history.",
  ASSIGNEE_UNAVAILABLE: "Select an employee from your merchant workspace.",
  FINDING_REQUIRED: "Record a finding and next action before resolving this case.",
  INVALID_COMMAND: "Check the required fields and try again.",
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
const timeText = (time: string) => time.replace("T", " ").slice(0, 19) + " UTC";
const sessionChannel = "changegate-merchant-session";

function notifySessionChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(sessionChannel);
  channel.postMessage("changed");
  channel.close();
}

export function MerchantConsole({ caseId }: { caseId?: string }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [workspace, setWorkspace] = useState<TeamWorkspaceView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignedOnly, setAssignedOnly] = useState(true);
  const session = workspace?.session;
  const cases = workspace?.cases ?? [];
  const detail = workspace?.detail;
  const item = detail?.case;

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

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (error instanceof RequestError && (error.status === 401 || error.code === "SESSION_CHANGED")) {
        setWorkspace(null);
      }
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function change(command: Extract<TeamCommand, { action: "record" | "assign" | "note" | "resolve" }>, message: string) {
    if (!session) return;
    const { sessionVersion } = session;
    void run(async () => {
      const saved = await send<TeamCaseDetail>(command, { sessionVersion });
      setWorkspace((current) => current?.session.sessionVersion === sessionVersion ? {
        ...current,
        detail: saved,
        cases: [saved.case, ...current.cases.filter(({ id }) => id !== saved.case.id)],
      } : current);
      setNotice(message);
    });
  }

  const visible = session && assignedOnly ? cases.filter((row) => row.assignee === session.username) : cases;
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div>
        <p className={styles.brand}>ChangeGate</p>
        <h1>Merchant workspace</h1>
        {session && <p className={styles.merchant}>{session.merchantName}</p>}
      </div>
      {session && <div className={styles.profile}>
        <span>{session.name}</span>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await send<null>({ action: "signOut" }, { sessionVersion: session.sessionVersion });
          setWorkspace(null);
          notifySessionChange();
          router.replace("/merchant");
          router.refresh();
        })}>Sign out</button>
      </div>}
    </header>
    <p className={styles.notice} role="status">{notice || (busy ? "Working…" : "")}</p>
    {!ready || (busy && !session) ? <p>Loading workspace…</p> : !session ? (
      <form className={styles.signIn} method="post" onSubmit={(event) => {
        const data = formValues(event);
        event.currentTarget.reset();
        void run(async () => {
          await send<TeamSession>({ action: "signIn", username: field(data, "username").trim().toLowerCase(),
            password: field(data, "password") });
          notifySessionChange();
          window.location.reload();
        });
      }}>
        <h2>Employee sign-in</h2>
        <label>Username<input name="username" autoComplete="username" maxLength={64} required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={160} required /></label>
        <button className={styles.primary} disabled={busy}>Sign in</button>
      </form>
    ) : (
      <div className={styles.grid}>
        <aside className={styles.card} aria-label="Case queue">
          <div className={styles.queueHeader}>
            <h2>{assignedOnly ? "Assigned to me" : "All cases"}</h2>
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              setWorkspace(null);
              setWorkspace(await send<TeamWorkspaceView>({ action: "workspace", id: caseId }));
            })}>Refresh</button>
          </div>
          <div className={styles.filters} aria-label="Queue filter">
            <button type="button" aria-pressed={assignedOnly} onClick={() => setAssignedOnly(true)}>Assigned to me</button>
            <button type="button" aria-pressed={!assignedOnly} onClick={() => setAssignedOnly(false)}>All cases</button>
          </div>
          {visible.length ? <ul className={styles.queue}>{visible.map((row) =>
            <li key={row.id}>
              <Link href={`/merchant/${row.id}`} prefetch={false} aria-current={row.id === caseId ? "page" : undefined}>
                <strong>{row.reference}</strong><span>{row.assigneeName} · {row.status}</span>
              </Link>
            </li>)}</ul> : <p className={styles.muted}>{assignedOnly ? "No cases are assigned to you." : "No cases yet."}</p>}
          <form className={styles.newCase} onSubmit={(event) => {
            const data = formValues(event);
            void run(async () => {
              const saved = await send<TeamCaseDetail>({ action: "create", reference: field(data, "reference") },
                { sessionVersion: session.sessionVersion });
              router.push(`/merchant/${saved.case.id}`);
            });
          }}>
            <h3>Open a case</h3>
            <label>Refund or ticket reference<input name="reference" maxLength={160} required /></label>
            <button className={styles.primary} disabled={busy}>Open case</button>
          </form>
        </aside>
        <section className={styles.card} aria-labelledby="case-heading">
          {!item || !detail ? <>
            <h2 id="case-heading">{caseId ? "Case unavailable" : "Refund case"}</h2>
            <p className={styles.muted}>{caseId ? "This case could not be opened in your workspace." : "Open a case or select one from the queue."}</p>
          </> : <>
            <div className={styles.caseHeader}>
              <h2 id="case-heading">{item.reference}</h2>
              <span className={styles.caseStatus} data-resolved={item.status === "Resolved"}>{item.status}</span>
            </div>
            <dl className={styles.facts}>
              <div><dt>Assigned to</dt><dd>{item.assigneeName}</dd></div>
              <div><dt>Last update</dt><dd><time dateTime={item.updatedAt}>{timeText(item.updatedAt)}</time></dd></div>
            </dl>
            {item.status === "Resolved" ? <dl className={styles.finding}>
              <dt>Finding</dt><dd>{item.finding}</dd>
              <dt>Next action</dt><dd>{item.nextAction}</dd>
            </dl> : (
              <fieldset key={item.id + ":" + item.revision} className={styles.editors} disabled={busy}>
                <legend className={styles.visuallyHidden}>Case updates</legend>
                <form onSubmit={(event) => {
                  const data = formValues(event);
                  change({ action: "record", id: item.id, revision: item.revision, finding: field(data, "finding"),
                    nextAction: field(data, "nextAction"), status: field(data, "status") === "Awaiting evidence" ?
                      "Awaiting evidence" : "Investigating" }, "Finding saved.");
                }}>
                  <label>Finding<textarea name="finding" defaultValue={item.finding} maxLength={1200} required /></label>
                  <label>Next action<textarea name="nextAction" defaultValue={item.nextAction} maxLength={1200} required /></label>
                  <div className={styles.formRow}>
                    <label>Case status<select name="status" defaultValue={item.status}>
                      {activeStatuses.map((label) => <option key={label}>{label}</option>)}
                    </select></label>
                    <button className={styles.primary}>Save finding</button>
                  </div>
                </form>
                <form className={styles.formRow} onSubmit={(event) => {
                  const data = formValues(event);
                  change({ action: "assign", id: item.id, revision: item.revision, assignee: field(data, "assignee") }, "Assignment saved.");
                }}>
                  <label>Assign to<select name="assignee" defaultValue={session.coworkers.some(({ username }) => username === item.assignee) ? item.assignee : ""} required>
                    <option value="" disabled>Select an employee</option>
                    {session.coworkers.map(({ username, name }) => <option key={username} value={username}>{name}</option>)}
                  </select></label>
                  <button>Assign case</button>
                </form>
                <form onSubmit={(event) => {
                  const data = formValues(event);
                  change({ action: "note", id: item.id, revision: item.revision, note: field(data, "note") }, "Note saved.");
                }}>
                  <label>Case note<textarea name="note" maxLength={1600} required /></label>
                  <button>Add note</button>
                </form>
                <button type="button" className={styles.resolve} disabled={!item.finding || !item.nextAction}
                  onClick={() => change({ action: "resolve", id: item.id, revision: item.revision }, "Case resolved.")}>Resolve case</button>
              </fieldset>
            )}
            <section className={styles.history} aria-labelledby="history-heading">
              <h3 id="history-heading">Case history</h3>
              <ol>{detail.history.map((event) => <li key={event.sequence}>
                <div><strong>{event.kind}</strong><span>{event.actor} · <time dateTime={event.occurredAt}>{timeText(event.occurredAt)}</time></span></div>
                <p>{event.detail}</p>
              </li>)}</ol>
            </section>
          </>}
        </section>
      </div>
    )}
  </main>;
}
