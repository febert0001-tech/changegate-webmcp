"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TeamCaseDetail, TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { csvLimit, refundMapping, type ImportSummary, type RefundImport, type RefundImportResult, type RefundMapping, type RefundRow, type Rejection } from "../../merchant-team/refund-csv";
import styles from "./merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
type Preview = { accepted: RefundRow[]; rejections: Rejection[]; findings: unknown[] };
const columns = [
  ["reference", "Refund reference"], ["amount", "Amount"], ["currency", "Currency"], ["status", "Status (optional)"],
] as const;
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function EvidenceRows({ rows }: { rows: RefundRow[] }) {
  return <div className={styles.tableWrap}>
    <table className={styles.evidenceTable}>
      <thead><tr><th scope="col">Source line</th><th scope="col">Refund reference</th><th scope="col">USD amount</th><th scope="col">File status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.reference}</td>
        <td>{usd.format(row.amountCents / 100)}</td><td>{row.status === undefined ? "Not mapped" : row.status || "Blank"}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function RejectedRows({ rows }: { rows: Rejection[] }) {
  if (!rows.length) return null;
  return <details className={styles.importSection} open>
    <summary>Why {rows.length} {rows.length === 1 ? "row was" : "rows were"} rejected</summary>
    <ul className={styles.rejections}>{rows.map(row => <li key={row.line}>
      <strong>Line {row.line}</strong> · {row.reasons.join(" ")}
    </li>)}</ul>
  </details>;
}

export function RefundImportPanel({ send, session, importId, onSessionError }: {
  send: Send; session: TeamSession; importId?: string; onSessionError: (error: unknown) => boolean;
}) {
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState<RefundImport | null>(null);
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const parsedMapping = refundMapping.safeParse(selection);
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
    <label>Refund CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      setRaw(""); setHeaders([]); setSelection({}); setPreview(null); setBatch(null);
      void run(async () => {
        if (file.size > csvLimit) throw Error("Choose a CSV no larger than 96 KiB.");
        const text = await file.text();
        const info = await request<{ headers: string[]; rowCount: number }>({ action: "inspectCsv", text });
        setRaw(text);
        setHeaders(info.headers);
        setNotice(info.rowCount + " source rows. Choose the matching columns.");
      });
    }} /></label>
    {!!headers.length && <form className={styles.importSection} onSubmit={event => {
      event.preventDefault();
      if (!parsedMapping.success) return;
      const mapping: RefundMapping = parsedMapping.data;
      void run(async () => {
        setPreview(await request<Preview>({ action: "previewCsv", text: raw, mapping }));
      });
    }}>
      <div className={styles.importMapping}>{columns.map(([field, label]) => <label key={field}>{label}
        <select name={field} disabled={busy} value={selection[field] ?? ""} onChange={event => {
          const value = event.target.value;
          setPreview(null);
          setSelection(current => {
            const next = { ...current };
            if (value === "") delete next[field]; else next[field] = Number(value);
            return next;
          });
        }}>
          <option value="">{field === "status" ? "Do not map" : "Select a column"}</option>
          {headers.map((header, i) => <option key={i} value={i}>{i + 1}. {header || "(blank header)"}</option>)}
        </select>
      </label>)}</div>
      <button disabled={busy || !parsedMapping.success}>Preview rows</button>
    </form>}
    {preview && <section className={styles.importSection} aria-label="Refund preview">
      <h3>Import preview</h3>
      <p>{preview.accepted.length} accepted · {preview.rejections.length} rejected · {preview.findings.length} findings</p>
      {preview.accepted.length > 25 && <p>Showing the first 25 accepted rows.</p>}
      {!!preview.accepted.length && <EvidenceRows rows={preview.accepted.slice(0, 25)} />}
      <RejectedRows rows={preview.rejections} />
      <button className={styles.primary} disabled={busy || !parsedMapping.success || !preview.accepted.length} onClick={() => {
        if (!parsedMapping.success) return;
        void run(async () => {
          const result = await request<RefundImportResult>({ action: "importCsv", text: raw, mapping: parsedMapping.data });
          setBatch(result.batch);
          setHistory(existing => [result.batch.summary, ...existing.filter(item => item.id !== result.batch.summary.id)]);
          setRaw(""); setHeaders([]); setPreview(null);
          setNotice(result.existing ? "This file was already imported. Showing its original findings and case links." : "Import saved.");
        });
      }}>Save import</button>
    </section>}
    {batch && <section className={styles.importSection} aria-label="Saved refund import">
      <h3>Import findings</h3>
      <p>{batch.summary.acceptedCount} accepted · {batch.summary.rejectedCount} rejected · {batch.summary.findingCount} findings</p>
      <RejectedRows rows={batch.rejections} />
      {batch.findings.length ? batch.findings.map(finding => <article className={styles.importFinding} key={finding.id}>
        <h4>{finding.kind}</h4>
        <p>{finding.explanation}</p>
        <EvidenceRows rows={finding.rows} />
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
