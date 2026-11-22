"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TeamCaseDetail, TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { refundMapping, type ImportSummary, type RefundImport, type RefundImportResult,
  type RefundRow, type Rejection } from "../../merchant-team/refund-csv";
import { changeMapping, inspectFile, MappingFields, RefundComparisonForm, type FileSelection } from "./refund-comparison-form";
import { EvidenceRows, findingTitle } from "./refund-evidence";
import styles from "./merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
type Preview = { accepted: RefundRow[]; rejections: Rejection[] };

function RejectedRows({ rows }: { rows: Rejection[] }) {
  if (!rows.length) return null;
  return <details className={styles.rejectionList} open>
    <summary>{rows.length} {rows.length === 1 ? "rejected row" : "rejected rows"}</summary>
    <ul className={styles.rejections}>{rows.map(row => <li key={`${row.side ?? ""}:${row.line}`}>
      <strong>{row.side && row.side + " export · "}Row {row.line}</strong> · {row.reasons.join(" ")}
    </li>)}</ul>
  </details>;
}

export function RefundImportPanel({ send, session, importId, onSessionError }: {
  send: Send; session: TeamSession; importId?: string; onSessionError: (error: unknown) => boolean;
}) {
  const [file, setFile] = useState<FileSelection | null>(null);
  const [savedFile, setSavedFile] = useState<FileSelection | null>(null);
  const [comparing, setComparing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState<RefundImport | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const parsedMapping = refundMapping.safeParse(file?.selection);
  const activeFinding = batch?.findings.find(finding => finding.id === selected);
  const version = session.sessionVersion;

  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const options = { sessionVersion: version, signal: abort.signal };
        const result = await send<ImportSummary[]>({ action: "listImports" }, options);
        const current = importId ? await send<RefundImport>({ action: "openImport", id: importId }, options) : null;
        if (abort.signal.aborted) return;
        setHistory(result);
        setBatch(current);
      } catch (error) {
        if (!abort.signal.aborted && !onSessionError(error)) setError(error instanceof Error ? error.message : "Import unavailable.");
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [importId, onSessionError, send, version]);

  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 740px)").matches) {
      const panel = document.getElementById("selected-refund-finding");
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: "start" });
    }
  }, [selected]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    setError("");
    try { await work(); }
    catch (error) {
      if (!onSessionError(error)) setError(error instanceof Error ? error.message : "Import unavailable.");
    } finally { setBusy(false); }
  }

  const request = <T,>(command: TeamCommand) => send<T>(command, { sessionVersion: version });

  async function makePreview(source: FileSelection) {
    const mapping = refundMapping.safeParse(source.selection);
    if (mapping.success) setPreview(await request<Preview>({ action: "previewCsv", text: source.text, mapping: mapping.data }));
  }

  function saveResult(result: RefundImportResult, message: string) {
    setBatch(result.batch);
    setSelected(null);
    setHistory(existing => [result.batch.summary, ...existing.filter(item => item.id !== result.batch.summary.id)]);
    setNotice(message);
  }

  return <section className={styles.card} aria-labelledby="refund-import">
    <div className={styles.screenHeading}>
      <h2 id="refund-import">{comparing ? "Compare processor export" : batch ? batch.comparison ? "Comparison findings" : "Import findings" : "Import refunds"}</h2>
      {batch?.comparison && !comparing && <Link className={styles.primary}
        href={`/merchant/imports/${batch.summary.id}?view=summary`} prefetch={false}>Review summary</Link>}
      {batch && !comparing && <Link href="/merchant/imports" prefetch={false} onClick={event => {
        if (importId) return;
        event.preventDefault();
        setBatch(null); setSavedFile(null); setSelected(null); setNotice(""); setError("");
      }}>New import</Link>}
    </div>
    {(notice || busy) && <p className={styles.inlineNotice} role="status">{notice || "Working…"}</p>}
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!batch && !comparing && <>
      <label className={styles.filePicker}>Refund CSV<input name="refundCsv" type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
        const selected = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!selected) return;
        setFile(null); setPreview(null);
        void run(async () => {
          const inspected = await inspectFile(request, selected);
          setFile(inspected);
          await makePreview(inspected);
        });
      }} /><span className={styles.fieldHint}>Select one redacted USD refund register.</span></label>
      {file && <section className={styles.importSection} aria-label="Detected columns">
        <div>
          <h3>Detected columns</h3>
          <p className={styles.fieldHint}>{file.name} · {file.rowCount} {file.rowCount === 1 ? "source row" : "source rows"}</p>
        </div>
        <MappingFields headers={file.headers} selection={file.selection} busy={busy} update={(field, value) => {
          setPreview(null);
          setFile({ ...file, selection: changeMapping(file.selection, field, value) });
        }} />
        {!parsedMapping.success && <p className={styles.fieldHint}>Choose the reference, amount, and currency columns to preview the rows.</p>}
        {!preview && <button type="button" className={styles.primary} disabled={busy || !parsedMapping.success}
          onClick={() => void run(() => makePreview(file))}>Preview rows</button>}
      </section>}
      {preview && <section className={styles.importSection} aria-label="Refund preview">
        <h3>Review before importing</h3>
        <p>{preview.accepted.length} accepted · {preview.rejections.length} rejected</p>
        {preview.accepted.length > 4 && <p className={styles.fieldHint}>Showing the first four accepted rows.</p>}
        {!!preview.accepted.length && <EvidenceRows rows={preview.accepted.slice(0, 4)} />}
        <RejectedRows rows={preview.rejections} />
        {!preview.accepted.length && <p>Correct the rejected rows or choose another file.</p>}
        <button className={styles.primary} disabled={busy || !parsedMapping.success || !preview.accepted.length || !file} onClick={() => {
          if (!parsedMapping.success || !file) return;
          void run(async () => {
            const result = await request<RefundImportResult>({ action: "importCsv", text: file.text, mapping: parsedMapping.data });
            saveResult(result, result.existing ? "Showing your original import and case links." : "Import saved.");
            setSavedFile(file); setFile(null); setPreview(null);
          });
        }}>Confirm import</button>
      </section>}
    </>}
    {comparing && <RefundComparisonForm initialMerchant={savedFile} request={request} run={run} busy={busy}
      onCancel={() => { setComparing(false); setNotice(""); setError(""); }}
      onSaved={result => {
        saveResult(result, result.existing ? "Showing your original comparison and case links." : "Comparison saved.");
        setComparing(false);
      }}
      renderPreview={result => <section className={styles.importSection} aria-label="Comparison preview">
        <h3>Review before saving</h3>
        <p>{result.comparison.exact.length} exact {result.comparison.exact.length === 1 ? "match" : "matches"} · {result.findings.length} {result.findings.length === 1 ? "exception" : "exceptions"}</p>
        <ul className={styles.previewFindings}>{result.findings.map(finding => <li key={finding.rows[0]!.reference}>
          <strong>{findingTitle(finding)}</strong><span>{finding.rows[0]!.reference}</span>
          {finding.differenceCents !== undefined && <EvidenceRows rows={finding.rows} files={result.comparison.files} />}
        </li>)}</ul>
        <RejectedRows rows={result.rejections} />
      </section>} />}
    {batch && !comparing && <section className={styles.batch} aria-label="Saved refund import">
      {batch.comparison ? <>
        <p className={styles.fieldHint}>{batch.comparison.period.start} to {batch.comparison.period.end} · USD</p>
        <p>{batch.summary.findingCount} {batch.summary.findingCount === 1 ? "exception" : "exceptions"} · {batch.comparison.exact.length} exact {batch.comparison.exact.length === 1 ? "match" : "matches"}</p>
      </> : <>
        <p>{batch.summary.acceptedCount} accepted · {batch.summary.rejectedCount} rejected · {batch.summary.findingCount} {batch.summary.findingCount === 1 ? "finding" : "findings"}</p>
        <button type="button" disabled={busy} onClick={() => {
          setComparing(true); setNotice(""); setError("");
        }}>Compare processor export</button>
      </>}
      {batch.findings.length ? <div className={styles.findingLayout}>
        <ul className={styles.findingList} aria-label="Findings">
          {batch.findings.map(finding => <li key={finding.id}>
            <button type="button" aria-pressed={finding.id === selected} aria-controls="selected-refund-finding" onClick={() => setSelected(finding.id)}>
              <strong>{findingTitle(finding)}</strong>
              <span>{finding.rows[0]!.reference}{finding.caseId && " · Case assigned"}</span>
            </button>
          </li>)}
        </ul>
        {activeFinding ? <article id="selected-refund-finding" tabIndex={-1} className={styles.importFinding} key={activeFinding.id}>
          <h3>{findingTitle(activeFinding)}</h3>
          <p>{activeFinding.explanation}</p>
          <EvidenceRows rows={activeFinding.rows} {...(batch.comparison && { files: batch.comparison.files })} />
          {activeFinding.caseId ? <Link className={styles.primary} href={`/merchant/${activeFinding.caseId}`} prefetch={false}>Open case</Link> :
            <form className={styles.formRow} onSubmit={event => {
              event.preventDefault();
              const assignee = String(new FormData(event.currentTarget).get("assignee") ?? "");
              void run(async () => {
                const saved = await request<TeamCaseDetail>({ action: "assignFinding", id: activeFinding.id, assignee });
                setBatch(current => current ? { ...current, findings: current.findings.map(row =>
                  row.id === activeFinding.id ? { ...row, caseId: saved.case.id } : row) } : current);
                setNotice("Case assigned to " + saved.case.assigneeName + ".");
              });
            }}>
              <label>Assign to<select name="assignee" required defaultValue="" disabled={busy}>
                <option value="" disabled>Select an employee</option>
                {session.coworkers.map(person => <option key={person.username} value={person.username}>{person.name}</option>)}
              </select></label>
              <button className={styles.primary} disabled={busy}>Create and assign</button>
            </form>}
        </article> : <p id="selected-refund-finding" className={styles.findingPrompt}>Select a finding to see its source rows and assign it.</p>}
      </div> : <p>{batch.comparison ? "No exceptions in these exports." : "No findings in the accepted rows."}</p>}
      {batch.comparison && !!batch.comparison.exact.length && <details className={styles.importSection}>
        <summary>View exact matches</summary>
        <EvidenceRows rows={batch.comparison.exact.flat()} files={batch.comparison.files} />
      </details>}
      <RejectedRows rows={batch.rejections} />
    </section>}
    {!!history.length && !comparing && <details className={styles.importSection}>
      <summary>Previous imports</summary>
      <ul className={styles.queue}>{history.map(item => <li key={item.id}>
        <Link prefetch={false} href={`/merchant/imports/${item.id}`}>{item.importedAt.replace("T", " ").slice(0, 19)} UTC · {item.findingCount} findings</Link>
      </li>)}</ul>
    </details>}
  </section>;
}
