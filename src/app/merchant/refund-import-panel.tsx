"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TeamCaseDetail, TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { refundMapping, type CaseComparison, type EvidenceRow, type ImportSummary, type RefundImport, type RefundImportResult, type RefundMapping, type RefundRow, type Rejection } from "../../merchant-team/refund-csv";
import { changeMapping, inspectFile, MappingFields, RefundComparisonForm, type FileSelection } from "./refund-comparison-form";
import styles from "./merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
type Preview = { accepted: RefundRow[]; rejections: Rejection[]; findings: unknown[] };
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function EvidenceRows({ rows, files }: { rows: EvidenceRow[]; files?: CaseComparison["files"] }) {
  const paired = rows.some(row => row.side);
  return <div className={styles.tableWrap}>
    <table className={styles.evidenceTable}>
      <thead><tr>{paired && <th scope="col">Export</th>}<th scope="col">Source line</th><th scope="col">Refund reference</th><th scope="col">USD amount</th><th scope="col">File status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.side ?? ""}:${row.line}`}>
        {paired && <td>{row.side}{row.side && files && <small className={styles.sourceFile}>{files[row.side]}</small>}</td>}
        <td>{row.line}</td><td>{row.reference}</td>
        <td>{row.amountCents === null ? "Unavailable" : usd.format(row.amountCents / 100)}</td>
        <td>{row.rejected ? "Rejected row" : row.status === undefined ? "Not mapped" : row.status || "Blank"}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function RejectedRows({ rows }: { rows: Rejection[] }) {
  if (!rows.length) return null;
  return <details className={styles.importSection} open>
    <summary>Why {rows.length} {rows.length === 1 ? "row was" : "rows were"} rejected</summary>
    <ul className={styles.rejections}>{rows.map(row => <li key={`${row.side ?? ""}:${row.line}`}>
      <strong>{row.side && row.side + " "}Line {row.line}</strong> · {row.reasons.join(" ")}
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
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const parsedMapping = refundMapping.safeParse(file?.selection);
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
        if (!abort.signal.aborted && !onSessionError(error)) setNotice(error instanceof Error ? error.message : "Import unavailable.");
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [importId, onSessionError, send, version]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try { await work(); }
    catch (error) {
      if (!onSessionError(error)) setNotice(error instanceof Error ? error.message : "Import unavailable.");
    } finally { setBusy(false); }
  }

  const request = <T,>(command: TeamCommand) => send<T>(command, { sessionVersion: version });
  return <section className={styles.card} aria-labelledby="refund-import">
    <h2 id="refund-import">Import refunds</h2>
    <p className={styles.muted}>Use one redacted USD refund CSV. Map the columns that belong in the review.</p>
    <p role="status" className={styles.notice}>{notice || (busy ? "Working…" : "")}</p>
    {!comparing && <>
    <label>Refund CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
      const selected = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!selected) return;
      setFile(null); setPreview(null); setBatch(null);
      void run(async () => {
        const inspected = await inspectFile(request, selected);
        setFile(inspected);
        setNotice(inspected.rowCount + " source rows. Check the selected columns.");
      });
    }} /></label>
    {file && <form className={styles.importSection} onSubmit={event => {
      event.preventDefault();
      if (!parsedMapping.success) return;
      const mapping: RefundMapping = parsedMapping.data;
      void run(async () => {
        setPreview(await request<Preview>({ action: "previewCsv", text: file.text, mapping }));
      });
    }}>
      <MappingFields headers={file.headers} selection={file.selection} busy={busy} update={(field, value) => {
        setPreview(null);
        setFile({ ...file, selection: changeMapping(file.selection, field, value) });
      }} />
      <button disabled={busy || !parsedMapping.success}>Preview rows</button>
    </form>}
    {preview && <section className={styles.importSection} aria-label="Refund preview">
      <h3>Import preview</h3>
      <p>{preview.accepted.length} accepted · {preview.rejections.length} rejected · {preview.findings.length} findings</p>
      {preview.accepted.length > 25 && <p>Showing the first 25 accepted rows.</p>}
      {!!preview.accepted.length && <EvidenceRows rows={preview.accepted.slice(0, 25)} />}
      <RejectedRows rows={preview.rejections} />
      <button className={styles.primary} disabled={busy || !parsedMapping.success || !preview.accepted.length || !file} onClick={() => {
        if (!parsedMapping.success || !file) return;
        void run(async () => {
          const result = await request<RefundImportResult>({ action: "importCsv", text: file.text, mapping: parsedMapping.data });
          setBatch(result.batch);
          setHistory(existing => [result.batch.summary, ...existing.filter(item => item.id !== result.batch.summary.id)]);
          setSavedFile(file); setFile(null); setPreview(null);
          setNotice(result.existing ? "This file was already imported. Showing its original findings and case links." : "Import saved.");
        });
      }}>Save import</button>
    </section>}
    {batch && !batch.comparison && <button type="button" disabled={busy} onClick={() => {
      setComparing(true);
      setNotice("");
    }}>Compare processor export</button>}
    </>}
    {comparing && <RefundComparisonForm initialMerchant={savedFile} request={request} run={run} busy={busy}
      onSaved={result => {
        setBatch(result.batch);
        setHistory(existing => [result.batch.summary, ...existing.filter(item => item.id !== result.batch.summary.id)]);
        setComparing(false);
        setNotice(result.existing ? "This pair was already compared. Showing its original findings and case links." : "Comparison saved.");
      }}
      renderPreview={result => <section aria-label="Comparison preview">
        <p>{result.comparison.exact.length} exact matches · {result.findings.length} exceptions</p>
        {result.findings.map(finding => <p key={finding.rows[0]!.reference}>{finding.explanation}</p>)}
        <RejectedRows rows={result.rejections} />
      </section>} />}
    {batch && !comparing && <section className={styles.importSection} aria-label="Saved refund import">
      <h3>{batch.comparison ? "Comparison findings" : "Import findings"}</h3>
      {batch.comparison && <>
        <p>Reporting period {batch.comparison.period.start} to {batch.comparison.period.end}</p>
        <details>
          <summary>{batch.comparison.exact.length} exact {batch.comparison.exact.length === 1 ? "match" : "matches"}</summary>
          {!!batch.comparison.exact.length && <EvidenceRows rows={batch.comparison.exact.flat()} files={batch.comparison.files} />}
        </details>
      </>}
      <p>{batch.summary.acceptedCount} accepted · {batch.summary.rejectedCount} rejected · {batch.summary.findingCount} findings</p>
      <RejectedRows rows={batch.rejections} />
      {batch.findings.length ? batch.findings.map(finding => <article className={styles.importFinding} key={finding.id}>
        <h4>{finding.kind}</h4>
        <p>{finding.explanation}</p>
        <EvidenceRows rows={finding.rows} {...(batch.comparison && { files: batch.comparison.files })} />
        {finding.caseId ? <Link href={`/merchant/${finding.caseId}`} prefetch={false}>Open assigned case</Link> :
          <form className={styles.formRow} onSubmit={event => {
            event.preventDefault();
            const assignee = String(new FormData(event.currentTarget).get("assignee") ?? "");
            void run(async () => {
              const saved = await request<TeamCaseDetail>({ action: "assignFinding", id: finding.id, assignee });
              setBatch(current => current ? { ...current, findings: current.findings.map(row =>
                row.id === finding.id ? { ...row, caseId: saved.case.id } : row) } : current);
              setNotice("Case assigned to " + saved.case.assigneeName + ".");
            });
          }}>
            <label>Assign to<select name="assignee" required defaultValue="" disabled={busy}>
              <option value="" disabled>Select an employee</option>
              {session.coworkers.map(person => <option key={person.username} value={person.username}>{person.name}</option>)}
            </select></label>
            <button className={styles.primary} disabled={busy}>Create and assign case</button>
          </form>}
      </article>) : <p>No findings in the accepted rows.</p>}
    </section>}
    {!!history.length && <section className={styles.importSection} aria-label="Previous imports">
      <h3>Previous imports</h3>
      <ul className={styles.queue}>{history.map(item => <li key={item.id}>
        <Link prefetch={false} href={`/merchant/imports/${item.id}`}>{item.importedAt.replace("T", " ").slice(0, 23)} UTC · {item.findingCount} findings</Link>
      </li>)}</ul>
    </section>}
  </section>;
}
