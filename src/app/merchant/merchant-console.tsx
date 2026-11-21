"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { parseUsd, type MerchantCapture, type MerchantCase, type MerchantCaseDetail, type MerchantCommand, type MerchantEnvironment } from "../../merchant/contracts";
import { merchantReceipt } from "../../merchant/receipt";
import { merchantWebMcp } from "../../merchant/webmcp";
import { getWebMcpModelContext } from "../../webmcp/native-contract";
import { registerWebMcpTools } from "../../webmcp/registration";
import { DecisionReceiptViewer } from "../decision-receipt-viewer";
import styles from "./merchant.module.css";

interface Session {
  operator: string;
  environment: MerchantEnvironment;
  maxRefundCents: number;
  executionEnabled: boolean;
}
const money = (value: number | null) => value === null ? "Unavailable" : (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const hydrationSubscription = () => () => {};
const label = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const errors: Record<string, string> = {
  MERCHANT_SANDBOX_CONFIGURATION_REQUIRED: "The local merchant workspace needs Sandbox or simulation configuration.",
  OPERATOR_AUTH_REQUIRED: "The operator name or password was rejected.",
  REFUND_HISTORY_UNCERTAIN: "The available PayPal history cannot establish the remaining balance.",
  REFUND_EXCEEDS_REMAINING_BALANCE: "The requested refund exceeds the remaining refundable balance.",
  REFUND_POLICY_LIMIT: "The requested amount exceeds the configured refund limit.",
  USD_CAPTURE_REQUIRED: "This workspace supports USD captures.",
  CAPTURE_NOT_REFUNDABLE: "The capture is ineligible for a refund in its current provider status.",
  MERCHANT_CAPTURE_NOT_FOUND: "No matching capture belongs to this merchant.",
  CASE_CHANGED_OR_ACTION_UNAVAILABLE: "This action is unavailable. Reopen the case to see its current state.",
};

async function send<T>(authorization: string, command: MerchantCommand, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/merchant", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error ? errors[data.error] ?? label(data.error) : "Request unavailable");
  }
  return response.json() as Promise<T>;
}

function downloadReceipt(detail: MerchantCaseDetail, environment: MerchantEnvironment) {
  const data = JSON.stringify(merchantReceipt(detail, environment), null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "changegate-merchant-receipt.json";
  try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

export function MerchantConsole() {
  const hydrated = useSyncExternalStore(hydrationSubscription, () => true, () => false);
  const [auth, setAuth] = useState<{ authorization: string; session: Session } | null>(null);
  const [webMcp, setWebMcp] = useState("Checking browser support");
  const [queue, setQueue] = useState<MerchantCase[]>([]);
  const [captures, setCaptures] = useState<MerchantCapture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MerchantCaseDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const capture = captures.find(({ captureId }) => captureId === selected);
  const refundCase = detail?.case;
  const canReconcile = refundCase && ["SUBMITTED", "PENDING", "UNCERTAIN"].includes(refundCase.status);

  useEffect(() => {
    if (!auth) return;
    const session = registerWebMcpTools(getWebMcpModelContext(document), () => merchantWebMcp(
      async (command, signal) => {
        const requestSignal = signal ? AbortSignal.any([signal, session.registrationSignal]) : session.registrationSignal;
        const result = await send<unknown>(auth.authorization, command, requestSignal);
        if (!requestSignal.aborted && (command.action === "propose" || command.action === "review")) {
          const updated = result as MerchantCaseDetail;
          setDetail((current) => !current || (current.case.id === updated.case.id &&
            current.audit.totalEvents <= updated.audit.totalEvents) ? updated : current);
          setQueue((current) => {
            const existing = current.find(({ id }) => id === updated.case.id);
            if (!existing) return [updated.case, ...current];
            // Tool mutations occur only before the operator decision. Keep any later human state.
            if (!["PROPOSED", "REVIEW"].includes(existing.status) ||
                (existing.status === "REVIEW" && updated.case.status === "PROPOSED")) return current;
            return current.map((item) => item.id === updated.case.id ? updated.case : item);
          });
        }
        return result;
      },
      auth.session,
    ));
    void session.ready.then((result) => {
      if (result.status !== "ABORTED") setWebMcp(result.status === "REGISTERED" ? "7 tools registered" : "Unavailable");
    });
    return session.dispose;
  }, [auth]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try { await operation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Request unavailable"); }
    finally { setBusy(false); }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    form.reset();
    await run(async () => {
      const authorization = "Basic " + btoa(String(fields.get("operator")) + ":" + String(fields.get("password")));
      const session = await send<Session>(authorization, { action: "session" });
      const cases = await send<MerchantCase[]>(authorization, { action: "queue" });
      setQueue(cases);
      setAuth({ authorization, session });
    });
  }

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const kind = fields.get("kind") === "capture" ? "capture" : "order";
    const reference = String(fields.get("reference") ?? "").trim();
    if (!auth) return;
    void run(async () => {
      setCaptures([]);
      setSelected(null);
      const results = await send<MerchantCapture[]>(auth.authorization, { action: "find", kind, reference });
      setCaptures(results);
      setSelected(results[0]?.captureId ?? null);
    });
  }

  function update(command: MerchantCommand) {
    if (!auth) return;
    void run(async () => {
      const next = await send<MerchantCaseDetail>(auth.authorization, command);
      setDetail(next);
      const cases = await send<MerchantCase[]>(auth.authorization, { action: "queue" });
      setQueue(cases);
      // Provider balance is a point-in-time view. Refresh explicitly after a case changes money.
      if (command.action === "execute" || command.action === "reconcile") {
        setCaptures([]);
        setSelected(null);
      }
    });
  }

  function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!capture) return;
    const value = String(new FormData(event.currentTarget).get("amount") ?? "").trim();
    const amountCents = value ? parseUsd(value) : null;
    if (value && (!amountCents || amountCents < 1)) {
      setNotice("Enter a positive USD amount with at most two decimal places.");
      return;
    }
    update({ action: "propose", captureId: capture.captureId, amountCents });
  }

  function signOut() {
    setAuth(null);
    setCaptures([]);
    setSelected(null);
    setQueue([]);
    setDetail(null);
    setWebMcp("Checking browser support");
    setNotice("");
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div><Link href="/">ChangeGate</Link><h1>Merchant refunds</h1></div>
        {auth && <div><p>{auth.session.environment} · {auth.session.operator}</p><p>WebMCP · {webMcp}</p>
          <button type="button" disabled={busy} onClick={signOut}>Sign out</button></div>}
      </header>
      <p role="status" className={styles.notice}>{notice || (busy ? "Working…" : "")}</p>
      {!auth ? (
        <form className={styles.card} method="post" action="/api/merchant" onSubmit={signIn}>
          <h2>Operator sign-in</h2>
          <label>Operator name<input name="operator" autoComplete="username" required /></label>
          <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
          <button disabled={busy || !hydrated}>Sign in</button>
        </form>
      ) : (
        <div className={styles.grid}>
          <section className={styles.card} aria-labelledby="lookup">
            <h2 id="lookup">Find a transaction</h2>
            <form onSubmit={find}>
              <label>Reference type<select name="kind"><option value="order">Order</option><option value="capture">Capture</option></select></label>
              <label>PayPal reference<input name="reference" minLength={5} maxLength={64} required /></label>
              <button disabled={busy}>Find transaction</button>
            </form>
            {captures.length > 1 && <label>Capture<select value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {captures.map(({ captureId }) => <option key={captureId}>{captureId}</option>)}
            </select></label>}
            {capture && <>
              <dl className={styles.facts}>
                <div><dt>Capture</dt><dd>{capture.captureId}</dd></div>
                <div><dt>Captured</dt><dd>{money(capture.amountCents)} {capture.currency} · {label(capture.status)}</dd></div>
                <div><dt>Remaining refundable</dt><dd>{money(capture.remainingCents)}</dd></div>
              </dl>
              <h3>Previous provider refunds</h3>
              {capture.refunds.length ? <ul>{capture.refunds.map((item) => <li key={item.refundId}>{item.refundId} · {item.currency} {item.amountCents / 100} · {label(item.status)}</li>)}</ul>
                : <p>No refunds in the available provider history.</p>}
              <h3>Outstanding attempts</h3>
              {capture.outstanding.length ? <ul>{capture.outstanding.map((item) => <li key={item.id}>{money(item.amountCents)} · {label(item.status)}</li>)}</ul>
                : <p>No outstanding ChangeGate attempts.</p>}
              <form onSubmit={propose}>
                <label>Partial amount in USD<input name="amount" inputMode="decimal" placeholder="Leave blank for full remaining balance" /></label>
                <button disabled={busy}>Create proposal</button>
              </form>
            </>}
          </section>
          <section className={styles.card} aria-labelledby="case">
            <h2 id="case">Refund case</h2>
            {!refundCase || !detail ? <p>Select a case from the queue or create a proposal.</p> : <>
              <p className={styles.status} role="status">{refundCase.status === "SUBMITTED"
                ? "Submitted · outcome unconfirmed" : label(refundCase.status)}</p>
              <dl className={styles.facts}>
                <div><dt>Case</dt><dd>{refundCase.id}</dd></div>
                <div><dt>Order and capture</dt><dd>{refundCase.orderId} · {refundCase.captureId}</dd></div>
                <div><dt>Proposal version</dt><dd>{refundCase.version}</dd></div>
                <div><dt>Requested refund</dt><dd>{money(refundCase.amountCents)} USD</dd></div>
                <div><dt>Human decision</dt><dd>{refundCase.decision ? label(refundCase.decision) : "Pending"} {refundCase.reviewer && " · " + refundCase.reviewer}</dd></div>
                {refundCase.decisionAt && <div><dt>Decision time</dt><dd>{refundCase.decisionAt}</dd></div>}
              </dl>
              <div className={styles.actions}>
                {refundCase.status === "PROPOSED" && <button disabled={busy} onClick={() => update({ action: "review", id: refundCase.id, version: refundCase.version })}>Request human review</button>}
                {refundCase.status === "REVIEW" && <>
                  <button disabled={busy} onClick={() => update({ action: "decide", id: refundCase.id, version: refundCase.version, decision: "approve" })}>Approve exact refund</button>
                  <button disabled={busy} onClick={() => update({ action: "decide", id: refundCase.id, version: refundCase.version, decision: "reject" })}>Reject</button>
                </>}
                {refundCase.status === "APPROVED" && <button disabled={busy || !auth.session.executionEnabled} onClick={() => update({ action: "execute", id: refundCase.id, version: refundCase.version })}>Execute approved refund</button>}
              </div>
              {refundCase.status === "APPROVED" && !auth.session.executionEnabled && <p>Sandbox execution is disabled by server configuration.</p>}
              {canReconcile && <form onSubmit={(event) => {
                event.preventDefault();
                const refundId = String(new FormData(event.currentTarget).get("refund") ?? "").trim();
                update({ action: "reconcile", id: refundCase.id, ...(refundId ? { refundId } : {}) });
              }}>
                <p>Read back the original attempt. If the refund cannot be located, check PayPal for its reference or escalate the case. The reserved balance stays held.</p>
                {!refundCase.refundId && <label>Provider refund reference (optional)<input name="refund" maxLength={64} /></label>}
                <button disabled={busy}>Reconcile original attempt</button>
              </form>}
              {refundCase.issue && <p>{label(refundCase.issue)}</p>}
              <h3>Provider evidence</h3>
              {refundCase.status === "COMPLETED" && <p>{auth.session.environment === "PayPal Sandbox" ? "Provider verified" : "Simulated provider matched"}</p>}
              {refundCase.observation ? <p>{refundCase.observation.refundId} · {label(refundCase.observation.status)} · {refundCase.observation.currency} {refundCase.observation.amountCents / 100} · {refundCase.observation.observedAt}</p>
                : <p>Independent readback is unavailable for this case.</p>}
              <h3>Decision and reconciliation history</h3>
              <ol>{detail.audit.events.map((event) => <li key={event.sequence}>{event.occurredAt} · {event.actor} · {label(event.type)}</li>)}</ol>
              {detail.audit.truncated && <p>Showing the latest {detail.audit.events.length} of {detail.audit.totalEvents} events.</p>}
              <DecisionReceiptViewer><button type="button" onClick={() => downloadReceipt(detail, auth.session.environment)}>Download decision receipt</button></DecisionReceiptViewer>
            </>}
          </section>
          <section className={styles.card} aria-labelledby="queue">
            <h2 id="queue">Operator queue</h2>
            <button disabled={busy} onClick={() => void run(async () => setQueue(await send(auth.authorization, { action: "queue" })))}>Refresh queue</button>
            {queue.length ? <ul className={styles.queue}>{queue.map((item) => <li key={item.id}>
              <button disabled={busy} onClick={() => update({ action: "case", id: item.id })}>
                {item.captureId} · {money(item.amountCents)} · {label(item.status)}
              </button>
            </li>)}</ul> : <p>No refund cases yet.</p>}
          </section>
        </div>
      )}
    </main>
  );
}
