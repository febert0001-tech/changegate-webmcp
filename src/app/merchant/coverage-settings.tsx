"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import type { CoverageSettingsView } from "../../merchant-team/overnight";
import { coverageDateTime, coverageInstant, coveragePermissions } from "../../merchant-team/coverage-time";
import styles from "./merchant.module.css";

type Props = {
  session: TeamSession;
  send: <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
  onSessionError: (error: unknown) => boolean;
};
type GrantCommand = Extract<TeamCommand, { action: "grantCoverage" | "startDemoCoverage" }>;
type Preview = { command: GrantCommand; reviewerName: string; window: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Coverage settings are unavailable.";

export function CoverageSettings({ session, send, onSessionError }: Props) {
  const [view, setView] = useState<CoverageSettingsView>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { sessionVersion } = session;

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const data = await send<CoverageSettingsView>({ action: "coverageSettings" }, { sessionVersion, signal: controller.signal });
        if (!controller.signal.aborted) setView(data);
      } catch (error) {
        if (!controller.signal.aborted && !onSessionError(error)) setError(errorMessage(error));
      } finally { loading = false; }
    }
    if (!busy) void load();
    const timer = window.setInterval(() => {
      if (!busy && document.visibilityState === "visible") void load();
    }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [busy, onSessionError, send, sessionVersion]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || preview || !view) return;
    setError("");
    const fields = new FormData(event.currentTarget);
    const location = String(fields.get("location"));
    const reviewer = String(fields.get("reviewer"));
    const account = view.reviewers.find(item => item.username === reviewer);
    if (!view.locations.includes(location) || !account) {
      setError("Select a store and reviewer.");
      return;
    }
    const id = crypto.randomUUID();
    const clicked = (event.nativeEvent as SubmitEvent).submitter;
    if (clicked?.getAttribute("value") === "demo") {
      setPreview({ command: { action: "startDemoCoverage", id, location, reviewer }, reviewerName: account.name,
        window: "Starts when confirmed and ends eight hours later." });
      return;
    }
    const start = String(fields.get("start"));
    const end = String(fields.get("end"));
    const from = coverageInstant(start);
    const through = coverageInstant(end);
    if (!from || !through || from >= through) {
      setError("Enter a start and a later end in Atlanta time. Choose a different time if it repeats or is skipped at a clock change.");
      return;
    }
    setPreview({ command: { action: "grantCoverage", id, location, reviewer, start, end },
      reviewerName: account.name, window: coverageDateTime(from) + " to " + coverageDateTime(through) });
  }

  async function save(command: GrantCommand | Extract<TeamCommand, { action: "revokeCoverage" }>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setView(await send<CoverageSettingsView>(command, { sessionVersion }));
      setPreview(undefined);
    } catch (error) { if (!onSessionError(error)) setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <section className={styles.card + " " + styles.overnightPanel} aria-label="Coverage settings">
    <h2>Coverage settings</h2>
    <p className={styles.fieldHint}>Simulated coverage · Atlanta time ({view?.timeZone ?? "America/New_York"})</p>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!view && !error && <p role="status">Loading coverage settings…</p>}
    {view && <>
      {view.reviewers.length ? <form onSubmit={review} aria-label="Schedule coverage">
        <fieldset className={styles.coverageFields} disabled={busy || Boolean(preview)}>
          <label>Store<select name="location" required defaultValue="">
            <option value="">Select a store</option>
            {view.locations.map(location => <option key={location}>{location}</option>)}
          </select></label>
          <label>Reviewer<select name="reviewer" required defaultValue="">
            <option value="">Select a reviewer</option>
            {view.reviewers.map(({ username, name }) => <option key={username} value={username}>{name}</option>)}
          </select></label>
          <label>Start · Atlanta time<input type="datetime-local" name="start" /></label>
          <label>End · Atlanta time<input type="datetime-local" name="end" /></label>
        </fieldset>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={busy || Boolean(preview)}>Review grant</button>
          <button type="submit" value="demo" disabled={busy || Boolean(preview)}>Start demo coverage</button>
        </div>
      </form> : <p>No coverage reviewers are configured.</p>}
      {preview && <div className={styles.overnightDetails} role="group" aria-label="Confirm shift coverage">
        <h3>Confirm shift coverage</h3>
        <p><strong>{preview.reviewerName} · {preview.command.location}</strong></p>
        <p>{preview.window}</p>
        <ul>{coveragePermissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
        <p>Refund decisions and payouts require separate merchant permissions.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void save(preview.command)}>Confirm coverage</button>
          <button type="button" disabled={busy} onClick={() => { setPreview(undefined); setError(""); }}>Edit grant</button>
        </div>
      </div>}
      <h3>Coverage grants</h3>
      {view.grants.length ? <ul className={styles.coverageGrants}>
        {view.grants.map(grant => <li key={grant.id} className={styles.overnightDetails}>
          <h4>{grant.location} · {grant.reviewerName} · {grant.status}</h4>
          <p>{coverageDateTime(grant.startsAt)} to {coverageDateTime(grant.endsAt)}</p>
          <p>Granted by {grant.grantedBy} · {coverageDateTime(grant.grantedAt)}</p>
          {grant.revokedAt && <p>Revoked by {grant.revokedBy} · {coverageDateTime(grant.revokedAt)}</p>}
          <p className={styles.fieldHint}>{coveragePermissions.join(" · ")}</p>
          {(grant.status === "Scheduled" || grant.status === "Active") && <button type="button" disabled={busy}
            aria-label={`End coverage now for ${grant.reviewerName} at ${grant.location}`}
            onClick={() => void save({ action: "revokeCoverage", id: grant.id })}>End coverage now</button>}
        </li>)}
      </ul> : <p>No coverage granted.</p>}
    </>}
  </section>;
}
