"use client";

import { useState } from "react";
import type { TeamCommand } from "../../merchant-team/contracts";
import { comparisonInput, type ComparisonInput } from "../../merchant-team/refund-comparison";
import { csvLimit, refundMapping, type ComparisonEvidence, type RefundFinding, type RefundImportResult, type Rejection } from "../../merchant-team/refund-csv";
import styles from "./merchant.module.css";

export const mappingFields = [
  ["reference", "Refund reference", ["refundreference", "reference", "refundid"]],
  ["amount", "Amount", ["refundamount", "amount"]],
  ["currency", "Currency", ["currency", "currencycode"]],
  ["status", "Status (optional)", ["refundstatus", "status"]],
] as const;

export function detectMapping(headers: string[]) {
  const keys = headers.map(header => header.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const mapping: Record<string, number> = {};
  for (const [field, , aliases] of mappingFields) {
    const candidates = keys.flatMap((key, index) => (aliases as readonly string[]).includes(key) ? [index] : []);
    if (candidates.length === 1) mapping[field] = candidates[0]!;
  }
  return mapping;
}

export function MappingFields({ headers, selection, prefix = "", busy, update }: {
  headers: string[]; selection: Record<string, number>; prefix?: string; busy: boolean;
  update: (field: string, value: string) => void;
}) {
  return <div className={styles.importMapping}>{mappingFields.map(([field, label]) => <label key={field}>{label}
    <select name={prefix + field} disabled={busy} value={selection[field] ?? ""} onChange={event => update(field, event.target.value)}>
      <option value="">{field === "status" ? "Do not map" : "Select a column"}</option>
      {headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header || "(blank header)"}</option>)}
    </select>
  </label>)}</div>;
}

export function changeMapping(selection: Record<string, number>, field: string, value: string) {
  const updated = { ...selection };
  if (value === "") delete updated[field];
  else updated[field] = Number(value);
  return updated;
}

export type FileSelection = { text: string; name: string; headers: string[]; rowCount: number; selection: Record<string, number> };
type Request = <T>(command: TeamCommand) => Promise<T>;
type ComparisonPreview = { acceptedCount: number; findings: RefundFinding[]; rejections: Rejection[]; comparison: ComparisonEvidence };

export async function inspectFile(request: Request, file: File): Promise<FileSelection> {
  if (file.size > csvLimit) throw Error("Choose a CSV no larger than 96 KiB.");
  if (!file.size) throw Error("Choose a CSV with a header and at least one refund row.");
  const text = await file.text();
  const info = await request<{ headers: string[]; rowCount: number }>({ action: "inspectCsv", text });
  return { text, name: file.name, ...info, selection: detectMapping(info.headers) };
}

export function RefundComparisonForm({ initialMerchant, request, run, busy, onSaved, renderPreview }: {
  initialMerchant: FileSelection | null; request: Request; run: (work: () => Promise<void>) => Promise<void>; busy: boolean;
  onSaved: (result: RefundImportResult) => void; renderPreview: (preview: ComparisonPreview) => React.ReactNode;
}) {
  const [merchant, setMerchant] = useState(initialMerchant);
  const [processor, setProcessor] = useState<FileSelection | null>(null);
  const [preview, setPreview] = useState<{ input: ComparisonInput; result: ComparisonPreview } | null>(null);
  const [dateError, setDateError] = useState("");
  return <form className={styles.importSection} aria-label="Compare processor export" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const start = String(data.get("periodStart") ?? "");
    const end = String(data.get("periodEnd") ?? "");
    if (start > end) {
      setDateError("The end date must be on or after the start date.");
      return;
    }
    const input = comparisonInput.safeParse({
      merchant: merchant && { text: merchant.text, name: merchant.name, mapping: merchant.selection },
      processor: processor && { text: processor.text, name: processor.name, mapping: processor.selection },
      period: { start, end },
    });
    if (!input.success) {
      setDateError("Check the dates, file names, and column mappings.");
      return;
    }
    void run(async () => setPreview({ input: input.data, result: await request({ action: "previewComparison", input: input.data }) }));
  }}>
    <h3>Compare processor export</h3>
    <p>Choose two redacted USD exports from the same reporting period.</p>
    {([["Merchant", merchant, setMerchant], ["Processor", processor, setProcessor]] as const).map(([side, file, setFile]) => {
      const prefix = side.toLowerCase();
      return <fieldset className={styles.comparisonFile} key={side}>
        <legend>{side === "Merchant" ? "Merchant refund register" : "Processor export"}</legend>
        <label>{side} CSV<input name={prefix + "Csv"} type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
          const next = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!next) return;
          setPreview(null);
          setFile(null);
          void run(async () => setFile(await inspectFile(request, next)));
        }} /></label>
        {file && <>
          <p className={styles.muted}>{file.name} · {file.rowCount} source rows</p>
          <MappingFields headers={file.headers} selection={file.selection} prefix={prefix + "-"} busy={busy}
            update={(field, value) => {
              setPreview(null);
              setFile({ ...file, selection: changeMapping(file.selection, field, value) });
            }} />
        </>}
      </fieldset>;
    })}
    <div className={styles.importMapping}>
      <label>Period start<input type="date" name="periodStart" required onInput={() => { setPreview(null); setDateError(""); }} /></label>
      <label>Period end<input type="date" name="periodEnd" required onInput={() => { setPreview(null); setDateError(""); }} /></label>
    </div>
    {dateError && <p role="alert">{dateError}</p>}
    {!preview ? <button className={styles.primary} disabled={busy || !refundMapping.safeParse(merchant?.selection).success ||
      !refundMapping.safeParse(processor?.selection).success}>Preview comparison</button> : <>
      {renderPreview(preview.result)}
      <button type="button" className={styles.primary} disabled={busy || !preview.result.acceptedCount}
        onClick={() => void run(async () => onSaved(await request({ action: "saveComparison", input: preview.input })))}>
        Save comparison
      </button>
    </>}
  </form>;
}
