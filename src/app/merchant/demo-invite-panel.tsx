"use client";

import { useEffect, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import styles from "./merchant.module.css";

type Plan = { startsAt: number; expiresAt: number };
type Invite = Plan & { id: string; recipient: string; status: string };
type Issued = Plan & { token: string; code: string };
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium",
});
const when = (value: number) => clock.format(new Date(value)) + " Eastern";
const messages: Record<string, string> = {
  INVITE_UNAVAILABLE: "This invitation is unavailable. Verify the name, separate code, and access window.",
  INVITE_PLAN_EXPIRED: "That issue time passed. Preview a new deadline.",
  INVITE_ALREADY_ISSUED: "This invite was already issued. Check the invite list.",
  INVITE_ADMIN_REQUIRED: "Sign in as the demo administrator.",
  INVITE_RECIPIENT_EMAIL_REQUIRED: "Enter the email the recipient will use to sign in through Cloudflare Access.",
};

async function post<T>(command: object): Promise<T> {
  const response = await fetch("/api/demo-access", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
  });
  const data = await response.json();
  if (!response.ok) throw Error(messages[data.error] ?? "Demo access is unavailable.");
  return data as T;
}

export function DemoInviteAdmin({ requireIdentity = false }: { requireIdentity?: boolean }) {
  const [list, setList] = useState<Invite[]>([]);
  const [prepared, setPrepared] = useState<Plan & { id: string; recipient: string; recipientEmail: string | undefined; minutes: number }>();
  const [issued, setIssued] = useState<Issued>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    let loading = false;
    async function load() {
      if (loading || !current || busy) return;
      loading = true;
      try {
        const result = await post<Invite[]>({ action: "list" });
        if (current) setList(result);
      } catch (failure) {
        if (current) setError(failure instanceof Error ? failure.message : "Demo access is unavailable.");
      } finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [busy]);

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Demo access is unavailable."); }
    finally { setBusy(false); }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const recipient = String(data.get("recipient") ?? "").trim();
    const recipientEmail = requireIdentity ? String(data.get("recipientEmail") ?? "").trim() : undefined;
    const minutes = Number(data.get("minutes"));
    void run(async () => {
      const plan = await post<Plan>({ action: "plan", recipient, recipientEmail, minutes });
      setPrepared({ ...plan, id: crypto.randomUUID(), recipient, recipientEmail, minutes });
      setIssued(undefined);
    });
  }

  function issue() {
    if (!prepared) return;
    const { recipient, recipientEmail, minutes, id, startsAt } = prepared;
    void run(async () => {
      setIssued(await post<Issued>({ action: "issue", recipient, recipientEmail, minutes, id, startsAt }));
      setPrepared(undefined);
    });
  }

  return <section className={styles.card + " " + styles.overnightPanel} aria-label="Demo invitations">
    <h2>Create demo invite</h2>
    <p>Access starts at the displayed issue time and ends at the fixed deadline.</p>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    <form onSubmit={prepare} className={styles.overnightDetails}>
      <label>Recipient name<input name="recipient" required maxLength={100} autoComplete="off" /></label>
      {requireIdentity && <label>Cloudflare sign-in email<input name="recipientEmail" type="email" required maxLength={254} autoComplete="off" /></label>}
      <label>Access minutes<input name="minutes" type="number" min={30} max={60} defaultValue={30} required /></label>
      <button type="submit" disabled={busy}>Preview expiration</button>
    </form>
    {prepared && <section className={styles.overnightDetails} aria-label="Confirm demo invite">
      <h3>Confirm demo invite for {prepared.recipient}</h3>
      {prepared.recipientEmail && <p>Cloudflare sign-in email {prepared.recipientEmail}</p>}
      <p>Issues at {when(prepared.startsAt)}</p>
      <p><strong>Expires at {when(prepared.expiresAt)}</strong></p>
      <button type="button" className={styles.primary} disabled={busy} onClick={issue}>Confirm invite</button>
    </section>}
    {issued && <section className={styles.overnightDetails} aria-label="Private invite details">
      <h3>Private invite details</h3>
      <p>Verify the named recipient through a trusted channel. Give the verification code separately from the link.</p>
      <label>Invite link<input name="invite-link" readOnly value={window.location.origin + "/demo-invite#" + issued.token} /></label>
      <label>Separate verification code<input name="invite-code" readOnly value={issued.code} /></label>
      <p>Expires at {when(issued.expiresAt)}</p>
      <button type="button" onClick={() => setIssued(undefined)}>Hide private details</button>
    </section>}
    <h3>Issued invites</h3>
    {list.length ? <ul className={styles.coverageGrants}>{list.map(invite => <li key={invite.id} className={styles.overnightDetails}>
      <h4>{invite.recipient} · {invite.status}</h4>
      <p>{when(invite.startsAt)} through {when(invite.expiresAt)}</p>
      {invite.status !== "Expired" && invite.status !== "Revoked" && <button type="button" disabled={busy}
        aria-label={"Revoke invite for " + invite.recipient}
        onClick={() => void run(async () => { setList(await post<Invite[]>({ action: "revoke", id: invite.id })); setIssued(undefined); })}>
        Revoke invite
      </button>}
    </li>)}</ul> : <p>No invites issued.</p>}
  </section>;
}

export function DemoInviteEntry() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function acceptLink() {
      const fragment = window.location.hash.slice(1);
      if (fragment) window.history.replaceState(null, "", window.location.pathname);
      if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) { setToken(fragment); setError(""); }
    }
    const frame = window.requestAnimationFrame(acceptLink);
    window.addEventListener("hashchange", acceptLink);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("hashchange", acceptLink); };
  }, []);

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await post({ action: "redeem", token, recipient: data.get("recipient"), code: data.get("code") });
      window.location.replace("/demo-guest");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Demo access is unavailable.");
    } finally { setBusy(false); }
  }

  return <main className={styles.shell}>
    <section className={styles.card + " " + styles.overnightPanel} aria-label="Redeem demo invitation">
      <p className={styles.brand}>ChangeGate</p>
      <h1>Investor demo access</h1>
      <p>Enter your invited name and the verification code provided separately.</p>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      {token ? <form onSubmit={event => void redeem(event)}>
        <label>Invited name<input name="recipient" required maxLength={100} autoComplete="off" /></label>
        <label>Verification code<input name="code" type="password" required autoComplete="off" maxLength={24} /></label>
        <button type="submit" className={styles.primary} disabled={busy}>Open walkthrough</button>
      </form> : <p>Open the complete invitation link from the demo administrator.</p>}
    </section>
  </main>;
}

type Snapshot = { expiresAt: number; remainingMs: number; walkthrough: { title: string; facts: string[] }[] };
type Deadline = { wall: number; monotonic: number };
const guestPollMs = 1000;
const guestLeaseMs = 4000;
const clockNow = (): Deadline => ({ wall: Date.now(), monotonic: performance.now() });
const remaining = (until: Deadline) => Math.min(until.wall - Date.now(), until.monotonic - performance.now());
const after = (start: Deadline, ms: number): Deadline => ({ wall: start.wall + ms, monotonic: start.monotonic + ms });
const earlier = (first: Deadline, second: Deadline): Deadline => ({
  wall: Math.min(first.wall, second.wall),
  monotonic: Math.min(first.monotonic, second.monotonic),
});

export function DemoGuestWalkthrough() {
  const [content, setContent] = useState<Snapshot>();
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let request: AbortController | undefined;
    let expiry: Deadline | undefined;
    let lease: Deadline | undefined;
    let timer: number | undefined;
    let paused = document.visibilityState !== "visible";
    let ended = false;
    let showingExamples = false;

    function cancelRequest() {
      const previous = request;
      request = undefined;
      previous?.abort();
    }
    function lock() {
      ended = true;
      window.clearTimeout(timer);
      cancelRequest();
      setContent(undefined);
      setLocked(true);
    }

    function watch(until: Deadline) {
      lease = until;
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, remaining(until));
    }

    async function check() {
      if (ended || paused) return;
      if ((expiry && remaining(expiry) <= 0) || (lease && remaining(lease) <= 0)) { lock(); return; }
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const sent = clockNow();
      if (!lease) watch(after(sent, guestLeaseMs));
      try {
        const response = await fetch("/api/demo-access", { cache: "no-store", signal: controller.signal });
        if (request !== controller) return;
        if (!response.ok) { lock(); return; }
        const current = await response.json() as Snapshot;
        if (request !== controller) return;
        if (!lease || remaining(lease) <= 0 || !Number.isFinite(current.remainingMs)) { lock(); return; }
        const reportedExpiry = after(sent, current.remainingMs);
        expiry = expiry ? earlier(expiry, reportedExpiry) : reportedExpiry;
        const nextLease = earlier(expiry, after(sent, guestLeaseMs));
        if (!showingExamples) {
          // A data response may have been authorized before revocation. Recheck
          // after receiving it before putting hidden examples back in the DOM.
          const confirmation = await fetch("/api/demo-access", {
            method: "HEAD", cache: "no-store", signal: controller.signal,
          });
          if (request !== controller) return;
          if (confirmation.status !== 204) { lock(); return; }
        }
        if (remaining(nextLease) <= 0) { lock(); return; }
        watch(nextLease);
        showingExamples = true;
        setContent(current);
      } catch {
        if (request === controller) lock();
      } finally {
        if (request === controller) request = undefined;
      }
    }

    function pause() {
      if (paused || ended) return;
      paused = true;
      cancelRequest();
      window.clearTimeout(timer);
      lease = undefined;
      showingExamples = false;
      // Clear the DOM before the browser can suspend or snapshot the page.
      flushSync(() => setContent(undefined));
    }

    function resume() {
      if (!paused || ended || document.visibilityState !== "visible") return;
      paused = false;
      void check();
    }

    const visibility = () => { if (document.visibilityState === "visible") resume(); else pause(); };
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", resume);
    window.addEventListener("blur", pause);
    window.addEventListener("focus", resume);
    document.addEventListener("freeze", pause);
    document.addEventListener("resume", resume);
    document.addEventListener("visibilitychange", visibility);
    const poll = window.setInterval(() => void check(), guestPollMs);
    void check();
    return () => {
      cancelRequest();
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("blur", pause);
      window.removeEventListener("focus", resume);
      document.removeEventListener("freeze", pause);
      document.removeEventListener("resume", resume);
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, []);

  return <main className={styles.shell} aria-label="Synthetic investor walkthrough">
    <header className={styles.header}><div><p className={styles.brand}>ChangeGate</p><h1>Investor walkthrough</h1></div></header>
    {locked && <section className={styles.card} role="status"><h2>Access ended</h2><p>Contact the presenter if you need access.</p></section>}
    {!locked && !content && <p role="status">Checking demo access…</p>}
    {content && <section className={styles.card + " " + styles.overnightPanel}>
      <p>Read-only synthetic examples · Access ends at {when(content.expiresAt)}</p>
      {content.walkthrough.map(item => <details open className={styles.overnightDetails} key={item.title}>
        <summary><strong>{item.title}</strong></summary>
        <ul>{item.facts.map(fact => <li key={fact}>{fact}</li>)}</ul>
      </details>)}
    </section>}
  </main>;
}
