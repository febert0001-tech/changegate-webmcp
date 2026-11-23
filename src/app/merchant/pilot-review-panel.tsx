"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { pilotDecisions, pilotOutcomes, pilotSides } from "../../merchant-team/pilot-contracts";
import type { PilotScope, PilotView } from "../../merchant-team/pilot-review";
import { formatUsd } from "../../merchant-team/refund-comparison";
import { refundMapping, type ExportSide } from "../../merchant-team/refund-csv";
import { changeMapping, inspectFile, MappingFields, type FileSelection } from "./refund-comparison-form";
import styles from "./merchant.module.css";

type Request = <T>(command: TeamCommand) => Promise<T>;
type Run = (operation: () => Promise<void>) => void;
type Save = (command: TeamCommand, onSaved?: () => void) => void;
type Mode = ExportSide;
const sourceLabel = (side: Mode) => side === "Merchant" ? "Register" : "Processor";
const rowAnchor = (side: Mode, line: number) => `pilot-${side.toLowerCase()}-row-${line}`;
const minuteFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const minutesText = (value: number | null | undefined) => value == null ? "Unmeasured" : minuteFormat.format(value) + " min";
const field = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const timeField = (data: FormData, key: string) => field(data, key) === "" ? null : Number(field(data, key));

function form(handler: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); handler(new FormData(event.currentTarget)); };
}

function Minutes({ label, name, value }: {label: string; name: string; value?: number | null}) {
  return <label>{label}<input type="number" name={name} min="0" max="10080" step="any" defaultValue={value ?? ""} placeholder="Unmeasured" /></label>;
}

function PilotSource({ side, view, busy, request, run, save }: { side: Mode; view: PilotView; busy: boolean;
  request: Request; run: Run; save: Save }) {
  const [file, setFile] = useState<FileSelection>();
  const source = view.sources.find(item => item.side === side);
  const mapping = refundMapping.safeParse(file?.selection);
  const rejections = new Map(source?.rejected.map(row => [row.line, row.reasons]));
  const mappedRows = source?.rows.map(row => ({ line: row.line, reference: row.reference,
    amount: row.amountCents === null ? "Unverified" : formatUsd(row.amountCents), status: row.status ?? "Unmapped", rejected: row.rejected }));
  const seen = new Set(mappedRows?.map(row => row.line));
  const rows = [...(mappedRows ?? []), ...(source?.rejected.filter(row => !seen.has(row.line)).map(row => ({
    line: row.line, reference: "Rejected row", amount: "Unverified", status: "Unverified", rejected: true
  })) ?? [])].sort((a, b) => a.line - b.line);
  return <section className={styles.overnightDetails} aria-label={sourceLabel(side) + " source"}>
    <h3>{sourceLabel(side)} export · {source ? "Present" : "Missing"}</h3>
    {source && <details>
      <summary>{source.name} · {source.accepted} accepted · {source.rejected.length} rejected</summary>
      <ul className={styles.pilotRows}>{rows.map(row => <li id={rowAnchor(side, row.line)} key={row.line} tabIndex={-1}>
        <strong>Row {row.line}</strong> · {row.reference} · {row.amount} · {row.status}
        {row.rejected && <p>{rejections.get(row.line)?.join(" ")}</p>}
      </li>)}</ul>
    </details>}
    <form onSubmit={form(() => {
      if (mapping.success && file) save({ action: "attachPilotFile", id: view.scope.id, source: side, scopeConfirmed: true,
        file: { text: file.text, name: file.name, mapping: mapping.data } }, () => setFile(undefined));
    })}>
      <label>{source ? "Reimport same " : "Choose "}{sourceLabel(side).toLowerCase()} CSV
        <input type="file" name={side.toLowerCase() + "Csv"} accept=".csv,text/csv" disabled={busy} onChange={event => {
          const next = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          setFile(undefined);
          if (next) run(async () => {
            const selected = await inspectFile(<T,>(command: TeamCommand) =>
              command.action === "inspectCsv" ? request<T>({ action: "inspectPilotCsv", text: command.text }) : request<T>(command), next);
            setFile(selected);
          });
        }} /></label>
      {file && <>
        <p>{file.name} · {file.rowCount} source rows</p>
        <MappingFields headers={file.headers} selection={file.selection} busy={busy} update={(key,value)=>
          setFile({ ...file, selection: changeMapping(file.selection,key,value) })} />
        <label className={styles.pilotCheck}><input type="checkbox" name="confirmScope" required />
          I verified the redacted USD export matches this location, register, week, and time zone.</label>
        <button type="submit" disabled={busy || !mapping.success}>{source ? "Reimport " : "Attach "}{sourceLabel(side).toLowerCase()} export</button>
      </>}
    </form>
  </section>;
}

function PilotBaseline({ view, save, busy }: { view: PilotView; save: Save; busy: boolean }) {
  const baseline = view.baseline;
  return <section className={styles.overnightDetails} aria-label="Usual process baseline">
    <h3>Usual process baseline</h3>
    {baseline ? <>
      <p>{minutesText(baseline.minutes)} active · {baseline.beforeFindings ? "Recorded before findings were shown" : "Recorded after findings were shown"}</p>
      <p className={styles.fieldHint}>{baseline.actor} · {baseline.at}</p>
      <p>{baseline.exceptions === null ? "Exceptions unmeasured" : baseline.exceptions.length + " exceptions found"}</p>
      {!!baseline.exceptions?.length && <ul>{baseline.exceptions.map((item,index)=><li key={index}>{item}</li>)}</ul>}
    </> : <form onSubmit={form(data => {
      const exceptions = field(data,"exceptions").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      save({ action: "savePilotBaseline", id: view.scope.id, minutes: timeField(data,"baseline"),
        exceptions: exceptions.length || data.has("exceptionsMeasured") ? exceptions : null });
    })}>
      <p className={styles.fieldHint}>Record the finance lead’s usual review of this same scope before viewing ChangeGate findings.</p>
      <Minutes label="Usual process active minutes" name="baseline" />
      <label className={styles.pilotCheck}><input type="checkbox" name="exceptionsMeasured" /> Staff recorded which exceptions they found</label>
      <label>Usual process exceptions, one per line<textarea name="exceptions" maxLength={8000} placeholder="Leave blank with the box checked if staff found zero." /></label>
      <button type="submit" disabled={busy} className={styles.primary}>Save baseline</button>
    </form>}
  </section>;
}

function PilotIssue({ issue, view, busy, save }: { issue: PilotView["issues"][number]; view: PilotView; busy: boolean; save: Save }) {
  return <article className={styles.overnightDetails}>
    <div className={styles.shiftAttentionHeading}><h4>{issue.kind}</h4><strong>{issue.outcome === "missed" ? "Missed by ChangeGate" : issue.outcome}</strong></div>
    <p>{issue.explanation}</p>
    {issue.note && issue.outcome !== "missed" && <p>{issue.note}</p>}
    <ul className={styles.pilotSourceLinks}>{issue.rows.map(row => {
      const side = row.side ?? "Merchant";
      const anchor = rowAnchor(side,row.line);
      return <li key={anchor}><a href={`#${anchor}`} onClick={() => {
        const details = document.getElementById(anchor)?.closest("details");
        if (details) details.open = true;
      }}>{sourceLabel(side)} row {row.line} · {row.reference}</a></li>;
    })}</ul>
    {issue.outcome !== "missed" && <form key={issue.revision} onSubmit={form(data => save({
      action: "decidePilotIssue", id: view.scope.id, caseId: issue.id, revision: issue.revision,
      outcome: field(data,"outcome") as (typeof pilotOutcomes)[number], note: field(data,"note")
    }))}>
      <label>Review outcome<select name="outcome" defaultValue={issue.outcome}>
        {pilotOutcomes.map(value=><option key={value}>{value}</option>)}</select></label>
      <label>Reviewer note<input name="note" defaultValue={issue.note} maxLength={400} /></label>
      <button type="submit" disabled={busy}>Save outcome</button>
    </form>}
    <details><summary>Case history</summary>
      <ol>{issue.history.map(event=><li key={event.sequence}>{event.kind} · {event.actor} · {event.occurredAt}<br />{event.detail}</li>)}</ol>
    </details>
  </article>;
}

function Scorecard({ view, save, busy }: {view: PilotView; save: Save; busy: boolean}) {
  const score = view.score;
  return <section className={styles.overnightPanel} aria-label="Pilot scorecard">
    <h2>Pilot scorecard</h2>
    {view.scope.synthetic === 1 && <p className={styles.fieldHint}>Synthetic acceptance run</p>}
    {score ? <div className={styles.pilotMetrics}>
      <p><strong>{score.decided ? score.confirmed + " of " + score.decided + " confirmed" : "Unmeasured"}</strong><br />Among decided ChangeGate flags</p>
      <p><strong>{score.flags} ChangeGate flags</strong><br />{score.confirmed} confirmed · {score.incorrect} incorrect · {score.unresolved} unresolved</p>
      <p><strong>{score.missed} merchant-confirmed {score.missed === 1 ? "miss" : "misses"} recorded</strong><br />{view.exact} exact reference-and-amount matches</p>
    </div> : <p>Exception accuracy and misses are unmeasured until both exports are compared and reviewed.</p>}
    <div className={styles.pilotMetrics}>
      <p><strong>{minutesText(view.baseline?.minutes)}</strong><br />Usual process active</p>
      <p><strong>{minutesText(view.time.review)}</strong><br />ChangeGate review active</p>
      <p><strong>{view.savedMinutes === null ? "Unmeasured" : minutesText(Math.abs(view.savedMinutes))}</strong><br />
        {view.savedMinutes !== null && view.savedMinutes < 0 ? "Additional active review time" : "Active time saved"}</p>
      <p><strong>{minutesText(view.time.setup)}</strong><br />Setup</p>
      <p><strong>{minutesText(view.time.waiting)}</strong><br />Waiting</p>
      <p><strong>{view.decision?.value ?? "Undecided"}</strong><br />Owner decision</p>
    </div>
    {view.decision && <p>{view.decision.actor} · {view.decision.at}{view.decision.note && " · " + view.decision.note}</p>}
    <div className={styles.pilotGrid}>
      <form className={styles.overnightDetails} onSubmit={form(data=>save({action:"savePilotTime",id:view.scope.id,
        review:timeField(data,"review"),setup:timeField(data,"setup"),waiting:timeField(data,"waiting")}))}>
        <h3>Record staff time</h3>
        <Minutes label="ChangeGate active review minutes" name="review" value={view.time.review} />
        <Minutes label="Setup minutes" name="setup" value={view.time.setup} />
        <Minutes label="Waiting minutes" name="waiting" value={view.time.waiting} />
        <button type="submit" disabled={busy}>Save staff time</button>
      </form>
      <form className={styles.overnightDetails} onSubmit={form(data=>save({action:"savePilotDecision",id:view.scope.id,
        decision:field(data,"decision") as (typeof pilotDecisions)[number],note:field(data,"decision-note")}))}>
        <h3>Decide on a second week</h3>
        <label>Owner decision<select name="decision" defaultValue={view.decision?.value ?? ""} required>
          <option value="">Choose a decision</option>{pilotDecisions.map(value=><option key={value}>{value}</option>)}</select></label>
        <label>Reason<textarea name="decision-note" defaultValue={view.decision?.note ?? ""} maxLength={400} /></label>
        <button type="submit" disabled={busy}>Save pilot decision</button>
      </form>
    </div>
  </section>;
}

export function PilotReviewPanel({ id, session, send, onSessionError }: { id?: string; session: TeamSession;
  send: <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
  onSessionError: (error: unknown) => boolean }) {
  const router = useRouter();
  const [view, setView] = useState<PilotView>();
  const [pilots, setPilots] = useState<PilotScope[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { sessionVersion, pilotEnabled } = session;
  useEffect(() => {
    if (!pilotEnabled) return;
    const controller = new AbortController();
    const options = { sessionVersion, signal: controller.signal };
    async function load() {
      try {
        if (id) setView(await send<PilotView>({ action: "openPilot", id }, options));
        else setPilots(await send<PilotScope[]>({ action: "listPilots" }, options));
      } catch (error) {
        if (!controller.signal.aborted && !onSessionError(error)) setError(error instanceof Error ? error.message : "Pilot unavailable.");
      }
    }
    void load();
    return () => controller.abort();
  }, [id, pilotEnabled, send, sessionVersion, onSessionError]);

  const request: Request = (command) => send(command,{sessionVersion});
  const run: Run = (operation) => {
    setBusy(true); setError("");
    void operation().catch(error=>{
      if (!onSessionError(error)) setError(error instanceof Error ? error.message : "Pilot unavailable.");
    }).finally(()=>setBusy(false));
  };
  const save: Save = (command, onSaved) => run(async () => {
    setView(await request<PilotView>(command));
    onSaved?.();
  });
  if (!pilotEnabled) return <section className={styles.card}><h2>Pilot review</h2><p>A merchant owner or manager can open this workspace.</p></section>;
  return <section className={styles.card + " " + styles.overnightPanel} aria-label="Merchant pilot review">
    <header className={styles.shiftAttentionHeading}><h2>{view ? "Closed-week pilot review" : "Start pilot review"}</h2>
      {id && <Link href="/pilot-review" prefetch={false}>All pilot reviews</Link>}</header>
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {!id && <>
      <p>{session.syntheticOnly ? "Synthetic demo only. Use fictional exports." : "Use merchant-authorized, redacted exports or label a synthetic run."} Pilot reviews read exports and save review records.</p>
      <form className={styles.overnightDetails} onSubmit={form(data => run(async () => {
        const saved = await request<PilotView>({action:"startPilot",location:field(data,"location"),register:field(data,"register"),
          week:field(data,"week"),timeZone:field(data,"timeZone"),synthetic:Boolean(session.syntheticOnly || data.has("synthetic"))});
        router.push("/pilot-review?id="+saved.scope.id);
      }))}>
        <div className={styles.pilotGrid}>
          <label>Location<input name="location" maxLength={120} list="pilot-locations" required /></label>
          <label>Register<input name="register" maxLength={120} list="pilot-registers" required /></label>
          <label>Closed week start<input type="date" name="week" required /></label>
          <label>Store time zone<input name="timeZone" list="pilot-zones" defaultValue="America/New_York" required /></label>
        </div>
        {session.merchantName === "Harbor Goods" && <>
          <datalist id="pilot-locations"><option>Harbor Fuel</option><option>Harbor Bar</option></datalist>
          <datalist id="pilot-registers"><option>Register 1</option><option>Bar 1</option></datalist>
        </>}
        <datalist id="pilot-zones">{["America/New_York","America/Chicago","America/Denver","America/Phoenix","America/Los_Angeles","UTC"].map(zone=><option key={zone}>{zone}</option>)}</datalist>
        <p className={styles.fieldHint}>The report covers seven calendar days ending at midnight in the store’s time zone.</p>
        {!session.syntheticOnly && <label className={styles.pilotCheck}><input type="checkbox" name="synthetic" /> Synthetic acceptance run</label>}
        <button type="submit" className={styles.primary} disabled={busy}>Start pilot review</button>
      </form>
      {pilots.length > 0 && <ul className={styles.pilotRows}>{pilots.map(pilot=><li key={pilot.id}>
        <Link href={"/pilot-review?id="+pilot.id} prefetch={false}>{pilot.location} · {pilot.register} · {pilot.week} to {pilot.end}{pilot.synthetic ? " · Synthetic" : ""}</Link></li>)}</ul>}
    </>}
    {id && !view && !error && <p role="status">Loading pilot review…</p>}
    {view && <>
      <p><strong>{view.scope.location} · {view.scope.register}</strong> · {view.scope.week} through {view.scope.end} · {view.scope.timeZone}{view.scope.synthetic ? " · Synthetic acceptance run" : ""}</p>
      <div className={styles.pilotGrid}>{pilotSides.map(side=><PilotSource key={side} side={side} view={view} busy={busy} request={request} run={run} save={save} />)}</div>
      <p>{view.comparisonReady ? "Both exports present. Comparison uses exact refund references and USD amounts." : view.sources.length
        ? "Worksheet only. Review available rows and validation errors. Cross-source discrepancies and matches remain unmeasured."
        : "Attach either export to start worksheet review."}</p>
      <PilotBaseline view={view} save={save} busy={busy} />
      {view.comparisonReady && !view.revealedAt && <button type="button" className={styles.primary} disabled={busy}
        onClick={()=>save({action:"revealPilot",id:view.scope.id})}>Show ChangeGate findings</button>}
      <Scorecard view={view} save={save} busy={busy} />
      {view.revealedAt && <>
        <h3>Exception review</h3>
        {view.issues.map(issue=><PilotIssue key={issue.id} issue={issue} view={view} busy={busy} save={save} />)}
        <form className={styles.overnightDetails} onSubmit={form(data=>save({action:"addPilotMiss",id:view.scope.id,
          reference:field(data,"reference"),note:field(data,"miss")}))}>
          <h4>Record an issue ChangeGate missed</h4>
          <label>Source refund reference<input name="reference" maxLength={160} required /></label>
          <label>Merchant-confirmed issue<textarea name="miss" maxLength={400} required /></label>
          <button type="submit" disabled={busy}>Save missed issue</button>
        </form>
      </>}
    </>}
  </section>;
}
