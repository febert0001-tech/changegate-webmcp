"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { discountPolicy, type DiscountCommand, type DiscountSale } from "../../merchant-team/discount-contracts";
import { canReview, cents, money } from "../../merchant-team/refund-requests";
import styles from "./merchant.module.css";

const reviewUrl = (reference?: string) => `/demo-sales${reference ? "/" + reference : ""}?discount=1`;
const pattern = "[0-9]{1,10}([.][0-9]{1,2})?";
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;

export function DiscountAudit({ sale }: { sale: DiscountSale }) {
  return <section className={styles.importSection}>
    <h3>Discount history</h3>
    <ol className={styles.rejections}>{sale.proposals.map((proposal, index) => <li key={index}>
      <strong>{proposal.actor}</strong> requested {money(proposal.discountCents)} off {money(proposal.originalCents)}
      {" · "}<time dateTime={proposal.at}>{proposal.at.replace("T", " ").slice(0, 19)} UTC</time>
      <p>{proposal.decision ? <><strong>{proposal.decision.result} by {proposal.decision.actor}</strong>
        {" · "}<time dateTime={proposal.decision.at}>{proposal.decision.at.replace("T", " ").slice(0, 19)} UTC</time></>
        : index === sale.proposals.length - 1 ? "Awaiting supervisor decision" : "Superseded before decision"}</p>
    </li>)}</ol>
    {sale.completion && <p>{sale.completion.subtotalCents === null ? <strong>Canceled by {sale.completion.actor}</strong>
      : <><strong>{money(sale.completion.subtotalCents)} final recorded subtotal</strong> · Finalized by {sale.completion.actor}</>}</p>}
  </section>;
}

function DiscountTerms({ original, discount, editing, busy, submit }: {
  original: string; discount: string; editing?: boolean; busy: boolean; submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [price, setPrice] = useState(original);
  const [reduction, setReduction] = useState(discount);
  const subtotal = /^\d{1,10}(\.\d{1,2})?$/.test(price) && /^\d{1,10}(\.\d{1,2})?$/.test(reduction)
    ? cents(price) - cents(reduction) : -1;
  return <form className={styles.importSection} onSubmit={submit}>
    <div className={styles.importMapping}>
      <label>Original pre-tax subtotal (USD)<input name="original" inputMode="decimal" pattern={pattern} required value={price}
        onChange={event => setPrice(event.target.value)} /></label>
      <label>Proposed discount (USD)<input name="discount" inputMode="decimal" pattern={pattern} required value={reduction}
        onChange={event => setReduction(event.target.value)} /></label>
    </div>
    <p>Proposed subtotal <strong>{subtotal > 0 ? money(subtotal) : "—"}</strong></p>
    <button className={styles.primary} type="submit" disabled={busy}>{editing ? "Send changed terms for review" : "Request discount approval"}</button>
  </form>;
}

export function DiscountSalesPanel({ reference, session, send, onSessionError }: {
  reference?: string; session: TeamSession; send: Send; onSessionError: (error: unknown) => boolean;
}) {
  const router = useRouter();
  const enabled = session.demoShift && !session.syntheticOnly && (session.demoRegister || canReview(session.role));
  const [records, setRecords] = useState<DiscountSale[]>();
  const [sale, setSale] = useState<DiscountSale | null>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const state = useRef({ generation: 0, pending: false, newReference: "" });
  const { sessionVersion } = session;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || state.current.pending) return;
      loading = true;
      const generation = state.current.generation;
      const valid = () => !controller.signal.aborted && generation === state.current.generation;
      const options = { sessionVersion, signal: controller.signal };
      try {
        if (reference) {
          const result = await send<DiscountSale | null>({ action: "demoDiscount", command: { operation: "open", reference } }, options);
          if (valid()) setSale(result);
        } else {
          const result = await send<DiscountSale[]>({ action: "demoDiscount", command: { operation: "list" } }, options);
          if (valid()) setRecords(result);
        }
      } catch (cause) {
        if (valid() && !onSessionError(cause)) setError("Could not load discount reviews.");
      } finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [enabled, onSessionError, reference, send, sessionVersion]);

  async function act(command: DiscountCommand) {
    if (state.current.pending) return;
    state.current.pending = true;
    state.current.generation++;
    setBusy(true);
    setError("");
    try {
      const result = await send<DiscountSale>({ action: "demoDiscount", command }, { sessionVersion });
      if (command.operation === "start") router.push(reviewUrl(result.reference));
      else {
        setSale(result);
        setEditing(false);
        setPassword("");
      }
    } catch (cause) {
      if (!onSessionError(cause)) setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally { setBusy(false); state.current.pending = false; }
  }

  const cashier = Boolean(session.demoRegister);
  const proposal = sale?.proposals.at(-1);
  const status = sale?.completion ? (sale.completion.choice === "cancel" ? "Canceled" : "Sale recorded")
    : proposal?.decision?.result ?? "Awaiting supervisor decision";
  return <section className={styles.card}>
    <div className={styles.screenHeading}>
      <div><h2>{reference ? "Harbor Bar sale" : cashier ? "Harbor Bar discount review" : "Discount approvals"}</h2>
        <p className={styles.fieldHint}>Harbor Bar · Bar 1 · Fictional demo · No payment submitted</p></div>
      <Link href={reference ? reviewUrl() : "/shift-overview?shift=manual"} prefetch={false}>
        {reference ? "Discount reviews" : "Manual demo overview"}</Link>
    </div>
    {error && <p role="alert" className={styles.formError}>{error}</p>}
    {!enabled ? <p>This demo is unavailable in your workspace.</p> : !reference ? <>
      <p><strong>Demo store policy</strong> · Discounts of {money(discountPolicy.minimumCents)} or more require supervisor approval before the sale can finish in the ChangeGate register.</p>
      {cashier && <DiscountTerms original="100.00" discount="30.00" busy={busy} submit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        state.current.newReference ||= "DEMO-SALE-" + crypto.randomUUID();
        void act({ operation: "start", reference: state.current.newReference, original: field(form, "original"), discount: field(form, "discount") });
      }} />}
      <section className={styles.importSection}><h3>{cashier ? "Your discount reviews" : "Supervisor queue"}</h3>
        {records?.length ? <ul className={styles.queue}>{records.map(row => {
          const current = row.proposals.at(-1)!;
          return <li key={row.reference}><Link href={reviewUrl(row.reference)} prefetch={false}>
            <strong>Harbor Bar · {money(current.discountCents)} discount</strong>
            <span>{row.cashier} · {row.completion ? row.completion.choice === "cancel" ? "Canceled" : "Sale recorded"
              : current.decision?.result ?? "Awaiting supervisor decision"}</span>
          </Link></li>;
        })}</ul> : <p>{records ? "No discount requests." : "Loading discount requests…"}</p>}
      </section>
    </> : !sale || !proposal ? <p>{sale === null ? "This discount review is unavailable." : "Loading discount review…"}</p> : <>
      <p className={styles.caseReference}>{reference}</p>
      <div className={styles.importSection} aria-label="Discount and next action">
        <h3>{status}</h3>
        <dl className={styles.facts}>
          <div><dt>Original pre-tax subtotal</dt><dd>{money(proposal.originalCents)}</dd></div>
          <div><dt>Requested discount</dt><dd>{money(proposal.discountCents)}</dd></div>
          <div><dt>Proposed subtotal</dt><dd>{money(proposal.originalCents - proposal.discountCents)}</dd></div>
        </dl>
        <p><strong>Reason for review</strong> · {sale.proposals.length > 1 ? "Changed terms require a fresh decision." :
          `The discount meets the ${money(discountPolicy.minimumCents)} demo store policy threshold.`}</p>
        {!sale.completion && <p role="status">{!proposal.decision ? "A supervisor must decide before the cashier can finish this sale."
          : proposal.decision.result === "Approved" ? "The cashier can finalize at the approved subtotal."
          : "The cashier can continue at the original full price or cancel."}</p>}
        {sale.completion && sale.completion.subtotalCents !== null && <Link href={`/demo-sales/${reference}`} prefetch={false}>Open recorded sale</Link>}
        {!sale.completion && cashier && !editing && <>
          {proposal.decision?.result === "Approved" && <button className={styles.primary} type="button" disabled={busy}
            onClick={() => void act({ operation: "finish", reference, revision: sale.proposals.length, choice: "discounted" })}>
            Finalize at {money(proposal.originalCents - proposal.discountCents)}</button>}
          {proposal.decision?.result === "Rejected" && <div className={styles.shiftOverviewActions}>
            <button className={styles.primary} type="button" disabled={busy}
              onClick={() => void act({ operation: "finish", reference, revision: sale.proposals.length, choice: "full price" })}>
              Continue at full price · {money(proposal.originalCents)}</button>
            <button type="button" disabled={busy}
              onClick={() => void act({ operation: "finish", reference, revision: sale.proposals.length, choice: "cancel" })}>Cancel sale</button>
          </div>}
          <p><button type="button" disabled={busy} onClick={() => setEditing(true)}>Edit sale or discount</button></p>
        </>}
        {!sale.completion && !proposal.decision && canReview(session.role) &&
          <form className={styles.importSection} onSubmit={event => {
            event.preventDefault();
            const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
            if (decision === "Approved" || decision === "Rejected")
              void act({ operation: "decide", reference, revision: sale.proposals.length, decision, password });
          }}>
            <label>Confirm with your password<input type="password" required value={password} autoComplete="current-password"
              onChange={event => setPassword(event.target.value)} /></label>
            <div className={styles.shiftOverviewActions}>
              <button className={styles.primary} type="submit" value="Approved" disabled={busy}>Approve discount</button>
              <button type="submit" value="Rejected" disabled={busy}>Reject discount</button>
            </div>
          </form>}
      </div>
      {editing && !sale.completion && <><DiscountTerms key={sale.proposals.length} original={(proposal.originalCents / 100).toFixed(2)}
        discount={(proposal.discountCents / 100).toFixed(2)} editing busy={busy} submit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void act({ operation: "revise", reference, revision: sale.proposals.length, original: field(form, "original"), discount: field(form, "discount") });
        }} /><button type="button" disabled={busy} onClick={() => setEditing(false)}>Discard edits</button></>}
      <DiscountAudit sale={sale} />
    </>}
  </section>;
}
