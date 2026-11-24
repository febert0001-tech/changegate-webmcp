"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import type { DemoSale } from "../../merchant-team/demo-sales";
import type { DiscountSale } from "../../merchant-team/discount-contracts";
import { DiscountAudit } from "./discount-sales-panel";
import { cents, currentStep, money, requestStatus, type RefundRequest } from "../../merchant-team/refund-requests";
import styles from "./merchant.module.css";

type Lookup = { sale: DemoSale; discount?: DiscountSale; balanceCents: number; paidCents: number; reservedCents: number; refunds: RefundRequest[] };
type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const usdPattern = "[0-9]{1,10}([.][0-9]{1,2})?";
const saleUrl = (reference: string) => "/demo-sales/" + encodeURIComponent(reference);

export function DemoSalesPanel({ reference, session, send, onSessionError }: {
  reference?: string; session: TeamSession; send: Send; onSessionError: (error: unknown) => boolean;
}) {
  const router = useRouter();
  const [lookup, setLookup] = useState<Lookup>();
  const [refunding, setRefunding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const saleSubmission = useRef<string | undefined>(undefined);
  const refundSubmission = useRef<string | undefined>(undefined);
  const { demoRegister, demoShift, sessionVersion } = session;
  useEffect(() => {
    if (!reference || !demoShift) return;
    const controller = new AbortController();
    void send<Lookup>({ action: "openDemoSale", reference }, { sessionVersion, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setLookup(result); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && !onSessionError(cause)) setError("This demo sale is unavailable in your workspace.");
      });
    return () => controller.abort();
  }, [demoShift, onSessionError, reference, send, sessionVersion]);
  async function submit(event: FormEvent<HTMLFormElement>, work: (form: FormData) => Promise<void>) {
    event.preventDefault();
    if (pending.current) return;
    const form = new FormData(event.currentTarget);
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work(form);
    } catch (cause) {
      if (!onSessionError(cause)) setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <section className={styles.card}>
    <div className={styles.screenHeading}>
      <div><h2>{reference ? "Recorded sale" : demoRegister ? "Record sale" : "Demo sales"}</h2>
        <p className={styles.fieldHint}>Fictional demo record · USD</p></div>
      <Link href="/shift-overview?shift=manual" prefetch={false}>Manual demo overview</Link>
    </div>
    {!!error && <p role="alert" className={styles.formError}>{error}</p>}
    {!demoShift ? <p>This demo sale is unavailable in your workspace.</p> : reference ? <>
      {!lookup && !error && <p role="status">Loading sale…</p>}
      {lookup && <>
        <p className={styles.caseReference}>{lookup.sale.reference}</p>
        <dl className={styles.facts}>
          <div><dt>{lookup.discount ? "Final recorded subtotal" : "Sale amount"}</dt><dd>{money(lookup.sale.originalCents)}</dd></div>
          <div><dt>Tender</dt><dd>{lookup.sale.tender}</dd></div>
          <div><dt>Cashier</dt><dd>{lookup.sale.cashier}</dd></div>
          <div><dt>Register</dt><dd>{lookup.sale.location} · {lookup.sale.register}</dd></div>
          <div><dt>Available for another request</dt><dd>{money(lookup.balanceCents)}</dd></div>
          <div><dt>Reserved by ChangeGate</dt><dd>{money(lookup.reservedCents)}</dd></div>
          <div><dt>Processor paid</dt><dd>{money(lookup.paidCents)}</dd></div>
        </dl>
        {lookup.discount && <DiscountAudit sale={lookup.discount} />}
        {lookup.refunds.length > 0 && <section className={styles.importSection}>
          <h3>Refund requests for this sale</h3>
          <ul className={styles.queue}>{lookup.refunds.map(refund => <li key={refund.id}>
            <Link href={`/transactions/${refund.id}/receipt`} prefetch={false}>
              <strong>{money(cents(refund.terms.amount))} refund receipt</strong><span>{requestStatus(refund)}</span>
            </Link>
          </li>)}</ul>
        </section>}
        {demoRegister && (refunding ? <form className={styles.importSection} onSubmit={event => void submit(event, async form => {
          const result = await send<RefundRequest>({ action: "createRefundRequest",
            submissionId: refundSubmission.current ??= crypto.randomUUID(),
            terms: { reference, amount: field(form, "amount"), currency: "USD", reason: field(form, "reason") },
          }, { sessionVersion });
          router.push(`/transactions/${result.id}/${currentStep(result)}`);
        })}>
          <h3>Request a partial refund</h3>
          <div className={styles.importMapping}>
            <label>Refund amount (USD)<input name="amount" inputMode="decimal" pattern={usdPattern} required /></label>
            <label>Reason<input name="reason" maxLength={1200} required /></label>
          </div>
          <button className={styles.primary} type="submit" disabled={busy}>Submit refund request</button>
        </form> : <button className={styles.primary} type="button" onClick={() => setRefunding(true)}>Request refund</button>)}
      </>}
    </> : <>
      {!session.syntheticOnly && <p><Link href="/demo-sales?discount=1" prefetch={false}>
        {demoRegister ? "Harbor Bar discount review demo" : "Discount approvals"}</Link></p>}
      {demoRegister && <form className={styles.importSection} onSubmit={event => void submit(event, async form => {
        const result = await send<DemoSale>({ action: "recordDemoSale", submissionId: saleSubmission.current ??= crypto.randomUUID(),
          amount: field(form, "amount"), tender: field(form, "tender") === "Cash" ? "Cash" : "Electronic",
        }, { sessionVersion });
        router.push(saleUrl(result.reference));
      })}>
        <p>{session.name} · {demoRegister.location} · {demoRegister.register}</p>
        <div className={styles.importMapping}>
          <label>Sale amount (USD)<input name="amount" inputMode="decimal" pattern={usdPattern} required /></label>
          <label>Tender<select name="tender"><option>Electronic</option><option>Cash</option></select></label>
        </div>
        <button className={styles.primary} type="submit" disabled={busy}>Save sale</button>
      </form>}
      <form className={styles.importSection} onSubmit={event => void submit(event, async form => {
        const result = await send<Lookup>({ action: "lookupOriginalSale", reference: field(form, "reference") }, { sessionVersion });
        if (!result?.sale.recordedDemo) throw new Error("No demo sale found for that reference.");
        router.push(saleUrl(result.sale.reference));
      })}>
        <label>Demo sale reference<input name="reference" required maxLength={46} /></label>
        <button type="submit" disabled={busy}>Find demo sale</button>
      </form>
    </>}
  </section>;
}
