"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import type { DemoState } from "../../merchant-team/demo-shift";
import type { DemoExplanation } from "../../merchant-team/refund-ai-explanation";
import { repeatWatchThreshold } from "../../merchant-team/refund-monitor-rules";
import { canReview, cents, checks, currentStep, executionStopped, money, payout, requestDecision, requestReceipt,
  providerAttempt, providerName, providerResponse, providerVerification, saleProvider, type ElectronicProvider, type RefundWatchEntry,
  requestStatus, submitted, transactionTabs, type RefundRequest, type TestSale, type TransactionStep } from "../../merchant-team/refund-requests";
import { PhoneAlerts } from "./phone-alerts";
import { RefundHistory } from "./refund-history";
import { useTransactionTools } from "./use-transaction-tools";
import { RefundThresholdPreview } from "./refund-threshold-preview";
import { canPreviewRefundThreshold, canPreviewSyntheticRefundWeek, type RefundPolicyHistory, type ThresholdPreview } from "../../merchant-team/refund-threshold-preview";
import styles from "../merchant/merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
type Lookup = { sale: TestSale; paidCents: number; reservedCents: number; balanceCents: number } | null;
type DemoView = { state: DemoState | null; inbox: { requestId: string; phase: number }[] };
type AlertView = { phase: number; status: string; advisory: string | null; explanation?: DemoExplanation };
const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const url = (id: string, step?: TransactionStep) => "/transactions/" + id + (step ? "/" + step : "");
const time = (value: string) => value.replace("T"," ").slice(0,19) + " UTC";

function approvedDemoWithoutSubmission(request: RefundRequest, demoShift?: boolean) {
  return demoShift === true && requestDecision(request)?.decision === "Approved" &&
    requestStatus(request) === "Blocked · Processor not connected" &&
    !providerAttempt(request) && !providerResponse(request) && !providerVerification(request);
}

function SaleFacts({ sale }: { sale: TestSale }) {
  const provider=saleProvider(sale);
  return <dl className={styles.facts}>
    <div><dt>Location</dt><dd>{sale.location}</dd></div>
    <div><dt>Register</dt><dd>{sale.register}</dd></div>
    <div><dt>Shift</dt><dd>{sale.shift}</dd></div>
    <div><dt>Original sale</dt><dd>{money(sale.originalCents)}</dd></div>
    <div><dt>{provider?"Provider refunds completed or pending":"Prior refunds on test sale"}</dt><dd>{money(sale.priorCents)}</dd></div>
    <div><dt>Sale source</dt><dd>{provider?providerName(provider)+" Sandbox":"ChangeGate test fixture"}</dd></div>
    {sale.paypal&&<div><dt>PayPal order</dt><dd>{sale.paypal.orderId}</dd></div>}
    <div><dt>Original tender</dt><dd>{sale.tender}</dd></div>
  </dl>;
}

function WatchActivity({ heading, count, entries, currentId }: {
  heading: string; count: number; entries: RefundWatchEntry[]; currentId: string;
}) {
  return <div>
    <h5>{heading} · {count} unusual requests</h5>
    {entries.length < count && <p className={styles.fieldHint}>Showing {entries.length} of {count} saved activity details.</p>}
    <ul className={styles.rejections}>{entries.map(entry => <li key={entry.id}>
      <time dateTime={entry.occurredAt}>{time(entry.occurredAt)}</time>
      {" · "}{entry.actor}{entry.location && " · " + entry.location}
      {" · "}{entry.register ?? "Register unavailable"}{" · "}{money(cents(entry.amount))}
      {entry.id === currentId && <> · <strong>This request</strong></>}
    </li>)}</ul>
  </div>;
}
export function TransactionWorkspace({destination,session,send,onSessionError}: {
  destination:"list"|{id:string;step:TransactionStep}; session:TeamSession; send:Send; onSessionError:(e:unknown)=>boolean;
}) {
  const router=useRouter();
  const [rows,setRows]=useState<RefundRequest[]>([]);
  const [record,setRecord]=useState<RefundRequest>();
  const [alertStatus,setAlertStatus]=useState<AlertView[]>([]);
  const [policy,setPolicy]=useState<RefundPolicyHistory>();
  const [query,setQuery]=useState("");
  const [location,setLocation]=useState("");
  const [register,setRegister]=useState("");
  const [shift,setShift]=useState("");
  const [employee,setEmployee]=useState("");
  const [newForm,setNewForm]=useState(false);
  const [reference,setReference]=useState("");
  const [source,setSource]=useState<"test"|ElectronicProvider>("test");
  const [lookup,setLookup]=useState<Lookup>();
  const [formId,setFormId]=useState("");
  const [busy,setBusy]=useState(false);
  const decisionPending=useRef(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [demo,setDemo]=useState<DemoView>();
  const id=destination==="list" ? undefined : destination.id;
  const version=session.sessionVersion;
  const manager=canReview(session.role);
  const includeExplanation=Boolean(session.syntheticOnly&&manager&&destination!=="list"&&destination.step==="approval");
  const includeSavedExplanation=Boolean(session.syntheticOnly&&destination!=="list"&&destination.step==="receipt");
  const read=useCallback((command:TeamCommand,signal:AbortSignal)=>
    send<RefundRequest|RefundRequest[]>(command,{signal,sessionVersion:version}),[send,version]);
  useTransactionTools(read);
  useEffect(()=>{
    const controller=new AbortController();
    const options={signal:controller.signal,sessionVersion:version};
    let running=false;
    async function load(){
      if(running) return;
      running=true;
      try {
        if(id){
          const [result,alerts]=await Promise.all([
            send<RefundRequest>({action:"openRefundRequest",id},options),
            send<AlertView[]>({action:"refundAlertStatus",id,...(includeExplanation&&{includeExplanation:true as const}),
              ...(includeSavedExplanation&&{includeSavedExplanation:true as const})},options),
          ]);
          if(!controller.signal.aborted){setRecord(result);setAlertStatus(alerts);}
        }else{
          const [result, shift]=await Promise.all([
            send<RefundRequest[]>({action:"listRefundRequests"},options),
            session.demoShift ? send<DemoView>({action:"demoShift"},options) : undefined,
          ]);
          if(!controller.signal.aborted){setRows(result);setDemo(shift);}
        }
      }catch(e){
        if(!controller.signal.aborted&&!onSessionError(e))setError(e instanceof Error?e.message:"Transactions unavailable.");
      }finally{
        running=false;
        if(!controller.signal.aborted)setLoading(false);
      }
    }
    void load();
    if(!id&&session.role==="owner"&&!session.syntheticOnly)void send<RefundPolicyHistory>({action:"refundPolicyHistory"},options)
      .then(result=>{if(!controller.signal.aborted)setPolicy(result);})
      .catch(e=>{if(!controller.signal.aborted&&!onSessionError(e))setError("Could not load the refund policy.");});
    const timer=id||manager||session.demoShift ? window.setInterval(()=>{if(document.visibilityState==="visible")void load();},5000):undefined;
    return()=>{controller.abort();if(timer!==undefined)window.clearInterval(timer);};
  },[id,includeExplanation,includeSavedExplanation,manager,onSessionError,send,session.demoShift,session.role,session.syntheticOnly,version]);

  async function run(work:()=>Promise<void>){
    setBusy(true);setError("");setNotice("");
    try{await work();}catch(e){if(!onSessionError(e))setError(e instanceof Error?e.message:"Transaction unavailable.");}
    finally{setBusy(false);}
  }
  const api=<T,>(command:TeamCommand)=>send<T>(command,{sessionVersion:version});
  const noticeBlock=<>{error&&<p className={styles.formError} role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</>;
  if(destination==="list"){
    const pending=rows.filter(r=>requestStatus(r)==="Needs manager decision"&&r.sale?.shift!=="Demo shift");
    const overBalance=rows.filter(r=>checks(r).route==="over-balance");
    const filtered=rows.filter(r=>
      (!location||r.sale?.location===location)&&(!register||r.sale?.register===register)&&(!shift||r.sale?.shift===shift)&&
      (!employee||submitted(r).actor===employee)&&
      [r.id,r.terms.reference,requestStatus(r),submitted(r).actor].some(s=>s.toLowerCase().includes(query.trim().toLowerCase())));
    const list=(items:RefundRequest[])=><ul className={styles.queue}>{items.map(r=><li key={r.id}>
      <Link href={url(r.id)} prefetch={false}>
        <strong>{r.terms.reference} · {money(cents(r.terms.amount))}</strong>
        <span>{requestStatus(r)} · {submitted(r).actor}{r.sale && " · "+r.sale.location+" · "+r.sale.register+" · "+r.sale.shift}</span>
        {requestStatus(r)==="Needs manager decision"&&<span>{checks(r).explanation}</span>}
      </Link></li>)}</ul>;
    return <section className={styles.card}>
      <div className={styles.screenHeading}><h2>Transactions</h2>
        {!session.syntheticOnly&&<button className={styles.primary} type="button" onClick={()=>{
          setNewForm(true);setReference("");setSource("test");setLookup(undefined);setFormId(crypto.randomUUID());setError("");
        }}>New refund</button>}</div>
      {session.reviewerConfigured===false&&<p className={styles.formError}>No supervisor is configured for this store. Ask your store administrator to assign a manager or owner.</p>}
      <p className={styles.fieldHint}>Test environment · No real money moves</p>
      {noticeBlock}
      {demo&&<section className={styles.importSection} aria-label="Synthetic shift">
        <h3>Synthetic shift</h3>
        <p>Harbor Fuel and Harbor Bar · Fictional transactions · Payment connectors disabled</p>
        {!demo.state&&session.role==="cashier"&&<form className={styles.formRow} onSubmit={event=>{
          event.preventDefault();
          const seed=value(new FormData(event.currentTarget),"seed");
          void run(async()=>setDemo(await api<DemoView>({action:"startDemoShift",seed})));
        }}>
          <label>Seed<input name="seed" defaultValue="harbor-evening" pattern="[A-Za-z0-9_\-]{1,40}" required disabled={busy}/></label>
          <button type="submit" disabled={busy}>Run demo shift</button>
        </form>}
        {demo.state&&(() => {
          const { event, finished, requestId, runId, seed, step, total }=demo.state;
          const refund=event.refund;
          return <>
            <p>Seed <strong>{seed}</strong> · Event {step+1} of {total} · {time(event.at)}</p>
            <h4>{event.title}</h4>
            {event.sale&&<><p>Reference <strong>{event.sale.reference}</strong></p><SaleFacts sale={event.sale}/></>}
            {event.discountCents!==undefined&&<p>Discount {money(event.discountCents)}</p>}
            {refund&&<p>Refund {money(cents(refund.amount))} · Assigned cashier {session.coworkers.find(member=>member.username===refund.cashier)?.name}</p>}
            {requestId&&<p><Link href={url(requestId)} prefetch={false}>Open generated refund</Link></p>}
            {refund&&event.sale&&refund.cashier===session.username&&!requestId&&<button type="button" className={styles.primary} disabled={busy}
              onClick={()=>void run(async()=>{
                if(!event.sale)return;
                const result=await api<RefundRequest>({action:"createRefundRequest",submissionId:crypto.randomUUID(),demoRun:runId,
                  terms:{reference:event.sale.reference,amount:refund.amount,currency:"USD",reason:refund.reason}});
                router.push(url(result.id,currentStep(result)));
              })}>Submit generated refund request</button>}
            {session.role==="cashier"&&<div className={styles.formRow}>
              <button type="button" disabled={busy||finished||Boolean(refund&&!requestId)} onClick={()=>void run(async()=>
                setDemo(await api<DemoView>({action:"nextDemoEvent",runId,step})))}>Next event</button>
              <button type="button" disabled={busy} onClick={()=>void run(async()=>{
                setDemo(await api<DemoView>({action:"replayDemoShift",runId}));
                setRows(await api<RefundRequest[]>({action:"listRefundRequests"}));
              })}>Replay this seed</button>
            </div>}
            {finished&&<p role="status">Generated shift complete.</p>}
          </>;
        })()}
        {manager&&<><h4>Simulated supervisor alerts</h4>
          {demo.inbox.length ? <ul className={styles.queue}>{demo.inbox.map(alert=><li key={alert.requestId}>
            <Link href={url(alert.requestId,"approval")} prefetch={false}>
              {alert.phase===0?"Primary review":"Backup escalation"} · {rows.find(row=>row.id===alert.requestId)?.terms.reference ?? "Open refund"}
            </Link></li>)}</ul> : <p>No demo alerts awaiting your decision.</p>}
        </>}
      </section>}
      {newForm&&<section className={styles.importSection} aria-label="New refund">
        <h3>Find original sale</h3>
        <form className={styles.formRow} onSubmit={event=>{
          event.preventDefault();
          void run(async()=>setLookup(await api<Lookup>({action:"lookupOriginalSale",reference,source})));
        }}>
          <label>Sale source<select name="saleSource" value={source} disabled={busy} onChange={e=>{
            const chosen=e.target.value;
            setSource(chosen==="square"||chosen==="paypal"?chosen:"test");setReference("");setLookup(undefined);setError("");
            setFormId(crypto.randomUUID());
          }}><option value="test">ChangeGate test records</option><option value="square">Square Sandbox</option>
            <option value="paypal">PayPal Sandbox</option></select></label>
          <label>{source==="paypal"?"PayPal capture reference":"Original payment reference"}<input name="reference" value={reference} maxLength={160} required disabled={busy}
            onChange={e=>{setReference(e.target.value);setLookup(undefined);setFormId(crypto.randomUUID());}} /></label>
          <button type="submit" disabled={busy||(source==="paypal"&&!session.paypalConnected)}>Find sale</button>
        </form>
        {source==="test"&&<p className={styles.fieldHint}>Test references: TEST-SALE-CASH, TEST-SALE-BALANCE, TEST-SALE-PARTIAL, TEST-SALE-ELECTRONIC, TEST-MONITOR-1 through 6</p>}
        {source==="paypal"&&!session.paypalConnected&&<p role="status">PayPal not connected</p>}
        {lookup!==undefined&&<>
          {lookup ? <><SaleFacts sale={lookup.sale} /><p><strong>{money(lookup.balanceCents)} remaining refundable</strong>
            {" · "+money(lookup.paidCents)+" reported here · "+money(lookup.reservedCents)+" reserved"}</p></>:
            <p className={styles.formError}>Sale could not be verified. Submit it for manager exception review.</p>}
          <form onSubmit={event=>{
            event.preventDefault();
            const form=new FormData(event.currentTarget);
            void run(async()=>{
              const result=await api<RefundRequest>({action:"createRefundRequest",submissionId:formId,terms:{
                ...(source!=="test"&&{source}),reference,amount:value(form,"amount"),currency:"USD",reason:value(form,"reason"),
              }});
              router.push(url(result.id,currentStep(result)));
            });
          }}>
            <div className={styles.importMapping}>
              <label>Refund amount (USD)<input name="amount" inputMode="decimal" pattern="[0-9]{1,10}([.][0-9]{1,2})?" required /></label>
              <label>Reason<input name="reason" maxLength={1200} required /></label>
            </div>
            <button className={styles.primary} disabled={busy}>{lookup?"Submit refund request":"Send for exception review"}</button>
          </form>
        </>}
      </section>}
      {manager&&<section className={styles.importSection} aria-labelledby="manager-queue">
        <h3 id="manager-queue">Manager queue</h3>
        {!session.demoShift&&!session.syntheticOnly&&<PhoneAlerts api={api}/>}<p role="status">{pending.length} {pending.length===1?"request needs":"requests need"} a decision</p>
        {!!pending.length&&list(pending)}
        {!!overBalance.length&&<details><summary>{overBalance.length} over-balance {overBalance.length===1?"request":"requests"} blocked</summary>
          {list(overBalance.slice(0,10))}</details>}
      </section>}
      {canPreviewRefundThreshold(session, Boolean(session.demoShift))&&<section className={styles.importSection}>
        <h3>Owner settings</h3>
        <RefundThresholdPreview requests={rows} merchantName={session.merchantName} preview={scope=>
          api<ThresholdPreview>({action:"previewRefundThreshold",...scope,
            ...(session.role==="owner"&&!session.syntheticOnly&&{prepareChange:true as const})})}
          previewExample={canPreviewSyntheticRefundWeek(session, Boolean(session.demoShift)) ? thresholdCents=>
            api<ThresholdPreview>({action:"previewSyntheticRefundWeek",thresholdCents}) : undefined}
          applyChange={session.role==="owner"&&!session.syntheticOnly ? async previewId=>{
            setPolicy(await api<RefundPolicyHistory>({action:"setRefundPolicy",previewId}));
            setNotice("Approval threshold applied.");
          } : undefined} />
        {session.role==="owner"&&!session.syntheticOnly&&<><h4>Owner activity</h4>
        {policy&&<section aria-label="Refund threshold history">
          <p>Active threshold <strong>{money(policy.thresholdCents)}</strong></p>
          <h5>Refund threshold history</h5>
          {policy.changes.length ? <ul>{policy.changes.map(change=><li key={change.id}>
            <strong>{money(change.oldCents)} → {money(change.newCents)}</strong> · {change.actor} ·{" "}
            <time dateTime={change.effectiveAt}>{time(change.effectiveAt)}</time> · Previewed store {change.location}
          </li>)}</ul> : <p>No threshold changes recorded.</p>}
        </section>}
        <div className={styles.importMapping}>{([
          ["Location",location,setLocation,rows.map(r=>r.sale?.location)],
          ["Register",register,setRegister,rows.map(r=>r.sale?.register)],
          ["Shift",shift,setShift,rows.map(r=>r.sale?.shift)],
          ["Employee",employee,setEmployee,rows.map(r=>submitted(r).actor)],
        ] as const).map(([label,selected,set,items])=><label key={label}>{label}<select value={selected} onChange={e=>set(e.target.value)}>
          <option value="">All</option>{[...new Set(items.filter(Boolean))].map(item=><option key={item}>{item}</option>)}
        </select></label>)}</div></>}
      </section>}
      <section className={styles.importSection}><h3>Refund activity</h3>
        <label>Search transactions<input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
        {loading?<p>Loading transactions…</p>:filtered.length?list(filtered):<p className={styles.emptyState}>No matching transactions.</p>}
      </section>
    </section>;
  }

  if(!record||record.id!==destination.id)return <section className={styles.card}>{noticeBlock}{loading&&<p>Loading refund…</p>}</section>;
  const {step}=destination;
  const review=requestDecision(record), check=checks(record), reported=payout(record);
  const stopped=executionStopped(record);
  const provider=saleProvider(record.sale), name=provider?providerName(provider):null;
  const connected=provider!=="paypal"||session.paypalConnected;
  const attempt=providerAttempt(record), response=providerResponse(record), verification=providerVerification(record);
  const verified=verification?.result==="Verified", failed=verification?.result==="Failed";
  const status=requestStatus(record);
  const approvedDemo=approvedDemoWithoutSubmission(record, session.demoShift);
  const demoCashier=session.demoShift && session.role==="cashier" && !provider;
  const cashierWaiting=demoCashier && status==="Needs manager decision";
  const cashierClosed=demoCashier && review?.decision==="Rejected";
  const supervisorClosed=session.demoShift && manager && !provider && step==="approval" && review?.decision==="Rejected";
  const current=approvedDemo || cashierClosed || supervisorClosed ? "receipt" : currentStep(record);
  const statusHeading=cashierWaiting ? "Waiting for supervisor review"
    : provider==="square"&&status==="Needs manager decision" ? "Supervisor approval required" : status;
  const customerUpdate=cashierWaiting ? "Your refund request is under review. No refund has been paid yet."
    : demoCashier && approvedDemo ? "Your refund was approved. It hasn’t been sent for payment."
    : cashierClosed ? "A supervisor declined your refund request. No refund was paid." : null;
  const outcome=verified ? name+" Sandbox refund verified · No real money moved"
    : failed ? name+" Sandbox reports the refund failed"
    : attempt && !stopped ? name+" Sandbox outcome unconfirmed"
    : reported ? "Test cash payout reported" : "No payout recorded";
  const next=cashierWaiting ? "You sent the request for review. Wait for the supervisor’s decision."
    : cashierClosed || supervisorClosed ? "This request is closed. Return to the transaction list."
    : status==="Needs manager decision" ? "A different supervisor must approve or reject this request."
    : check.route==="over-balance" ? "Cashier: check the balance and start a new request for an eligible amount."
    : review?.decision==="Rejected" ? "No payout action is available. Return to the transaction list."
    : approvedDemo ? "No action needed. Payment submission is disabled in this demo."
    : stopped ? stopped.reason
    : status==="Ready for cash payout" ? "Cashier: confirm and record the test cash payout in Execution."
    : reported ? "Cashier: open the receipt for the recorded employee report."
    : verified || failed ? "Open the receipt for the independent provider readback."
    : !connected ? "PayPal not connected"
    : response ? "Check the receipt for the latest "+name+" status."
    : attempt ? provider==="paypal"?"Reconcile the original PayPal attempt from Execution.":"Retry the original Square attempt from Execution."
    : provider ? "Execute the refund in "+name+" Sandbox."
    : "Execution is blocked until a payment processor is connected.";
  return <section className={styles.card} aria-labelledby="refund-heading">
    <div className={styles.screenHeading}><h2 id="refund-heading">Refund · {money(cents(record.terms.amount))}</h2><Link href="/transactions">All transactions</Link></div>
    <p className={styles.caseReference}>{record.terms.reference} · {record.sale?.location??"Sale unverified"} · {name?name+" Sandbox":"Test data"}</p>
    {record.sale?.recordedDemo && <Link href={`/demo-sales/${record.sale.reference}`} prefetch={false}>Open recorded demo sale</Link>}
    <section className={styles.transactionSummary} aria-label="Refund status and next action">
      <p className={styles.statusHeading}>
        <strong>{approvedDemo ? "Approved / Not submitted" : statusHeading}</strong>
        <span>Current step · {transactionTabs.find(([tab])=>tab===current)?.[1]}</span>
      </p>
      {approvedDemo&&review&&<p>Approved by <strong>{review.actor}</strong></p>}
      {supervisorClosed&&<p>Rejected by <strong>{review.actor}</strong></p>}
      <dl className={styles.moneySummary}>
        <div><dt>Requested</dt><dd>{money(cents(record.terms.amount))}</dd></div>
        <div><dt>Refundable at request</dt><dd>{check.balanceCents===null?"Unavailable":money(check.balanceCents)}</dd></div>
        {approvedDemo ? <div><dt>Confirmed payout</dt><dd>{money(0)}</dd></div> :
          <div><dt>Money movement</dt><dd>{outcome}</dd></div>}
      </dl>
      <p><strong>Next action</strong> {next}</p>
      {customerUpdate && <p role="status"><strong>What to tell the customer</strong> {customerUpdate}</p>}
      {approvedDemo&&step==="receipt"&&<p><strong>Why it was held</strong> {check.explanation}</p>}
      {step!==current && status==="Ready for cash payout" && <Link href={url(record.id,current)}>Open execution</Link>}
    </section>
    <nav className={styles.transactionTabs} aria-label="Refund process">{transactionTabs.map(([tab,label])=>
      <Link key={tab} href={url(record.id,tab)} aria-current={tab===step?"page":undefined} prefetch={false}>{label}</Link>)}</nav>
    {noticeBlock}
    <section className={styles.importSection}>
      {step==="sale"&&<>
        <h3>Original sale and request</h3>{record.sale?<SaleFacts sale={record.sale}/>:<p>Original sale unavailable.</p>}
        <p>Requested by {submitted(record).actor} · {time(submitted(record).occurredAt)}</p>
        <p><strong>Reason</strong> {record.terms.reason}</p>
      </>}
      {step==="checks"&&<>
        <h3>Refund checks</h3><p>{check.explanation}</p>
        <ul className={styles.rejections}>
          <li>Request format and USD amount passed.</li>
          <li>{provider==="square"?"Square confirmed a completed USD card sale for the configured merchant and location.":
            provider==="paypal"?"PayPal confirmed the USD capture, merchant ownership and refund history.":
            record.sale?"Original sale found in the test POS records.":"Original sale could not be verified."}</li>
          <li>Remaining refundable balance {check.balanceCents===null?"unavailable":money(check.balanceCents)}</li>
          <li>Store approval threshold {money(check.thresholdCents)}</li>
          {check.reservedCents!==undefined&&<li>Reserved by ChangeGate before this request {money(check.reservedCents)}</li>}
          {check.cumulativeCents!==null&&<li>Cumulative requested amount {money(check.cumulativeCents)}</li>}
        </ul>
        {check.monitoring&&<>
          <p>Rule version {check.monitoring.ruleVersion}</p>
          {check.monitoring.z!==null&&<p>Relative-size score {check.monitoring.z.toFixed(2)} (test baseline)</p>}
          {check.monitoring.watch&&<p>Unusual refunds in 15 minutes · Cashier {check.monitoring.cashierWatchCount} · Register {check.monitoring.registerWatchCount}</p>}
          {!!check.monitoring.reasons.length&&<ul className={styles.rejections}>{check.monitoring.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>}
          {!!check.monitoring.related.length&&<details><summary>Earlier watch signals</summary><ul>{check.monitoring.related.map(id=><li key={id}><Link href={url(id,"checks")}>Open {id}</Link></li>)}</ul></details>}
          {check.monitoring.drift?<details><summary>Register drift · Synthetic observation only</summary>
            <p>These completed test windows do not change the refund decision.</p>
            <ul className={styles.rejections}>{check.monitoring.drift.windows.map(window=><li key={window.endedAt}>
              {window.endedAt} · {window.refunds} refunds in {window.salesAndRefunds} transactions · Smoothed share {(window.ewma*100).toFixed(2)}%
              {" · Threshold "+(window.percentile*100).toFixed(2)+"%"+(window.elevated?" · Elevated":"")}
            </li>)}</ul>
          </details>:<p className={styles.fieldHint}>Register drift is unavailable until comparable POS sales and refund totals are connected.</p>}
        </>}
        {check.route==="over-balance"&&<Link className={styles.primary} href="/transactions">Return to transactions</Link>}
      </>}
      {step==="approval"&&<>
        <h3>Supervisor decision</h3>
        <dl className={styles.facts}>
          <div><dt>Employee</dt><dd>{submitted(record).actor}</dd></div>
          <div><dt>Original sale</dt><dd>{record.sale?money(record.sale.originalCents):"Unavailable"}</dd></div>
          <div><dt>Register</dt><dd>{record.sale?.register??"Unavailable"}</dd></div>
        </dl>
        <p><strong>Reason</strong> {record.terms.reason}</p>
        {check.monitoring?.reasons.length ? <>
          <h4>Rules that triggered</h4>
          <ul className={styles.rejections}>{check.monitoring.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
          {!check.monitoring.reasons.includes(check.explanation)&&<p><strong>Why it stopped</strong> {check.explanation}</p>}
        </> : <p><strong>Why it stopped</strong> {check.explanation}</p>}
        {check.cumulativeCents !== null && check.cumulativeCents < check.thresholdCents && <p>
          <strong>Below the store amount threshold.</strong> Refunds on this sale would total {money(check.cumulativeCents)},
          against a {money(check.thresholdCents)} review threshold.
        </p>}
        {record.watchActivity && check.monitoring && <>
          <h4>Activity counted toward the 15-minute rules</h4>
          {check.monitoring.cashierWatchCount >= repeatWatchThreshold && <WatchActivity
            heading={submitted(record).actor + " across registers"} count={check.monitoring.cashierWatchCount}
            entries={record.watchActivity.cashier} currentId={record.id} />}
          {check.monitoring.registerWatchCount >= repeatWatchThreshold && <WatchActivity
            heading={(record.sale?.register ?? "This register") + " across cashiers"} count={check.monitoring.registerWatchCount}
            entries={record.watchActivity.register} currentId={record.id} />}
        </>}
        {includeExplanation&&alertStatus[0]?.explanation&&<section className={styles.importSection}>
          <h4>AI explanation</h4>
          {alertStatus[0].explanation.status==="complete" ? <>
            <p>{alertStatus[0].explanation.summary}</p>
            <p className={styles.fieldHint}>{alertStatus[0].explanation.model} · {alertStatus[0].explanation.responseMs} ms
              {alertStatus[0].explanation.usage&&` · ${alertStatus[0].explanation.usage.input} input / ${alertStatus[0].explanation.usage.output} output tokens`}</p>
          </> : <p role="status">{alertStatus[0].explanation.status==="pending"?"Preparing AI explanation…":"AI explanation unavailable"}</p>}
          <p className={styles.fieldHint}>ChangeGate enforces the hold. The supervisor makes the decision.</p>
        </section>}
        {alertStatus.map(alert=><div key={alert.phase}>
          <p>{alert.phase===0?"Primary":"Backup"} alert · {alert.status}</p>
          {alert.advisory&&<p>AI advisory: {alert.advisory}</p>}
        </div>)}
        {review?<p><strong>{review.decision}</strong> by {review.actor} · {time(review.occurredAt)}</p>:
          status==="Needs manager decision"&&manager ? <form onSubmit={event=>{
            event.preventDefault();
            if(decisionPending.current)return;
            const native=event.nativeEvent as SubmitEvent;
            const decision=(native.submitter as HTMLButtonElement|null)?.value;
            if(decision!=="Approved"&&decision!=="Rejected")return;
            const form = event.currentTarget;
            const password = String(new FormData(form).get("supervisorPassword") ?? "");
            form.reset();
            decisionPending.current=true;
            void run(async()=>{
              const result=await api<RefundRequest>({action:"decideRefundRequest",id:record.id,decision,password});
              setRecord(result);setNotice("Decision saved.");
              const nextStep=approvedDemoWithoutSubmission(result, session.demoShift) ? "receipt" : currentStep(result);
              router.push(url(record.id,nextStep));
            }).finally(()=>{decisionPending.current=false;});
          }}>
            <label>Confirm with your password<input name="supervisorPassword" type="password" autoComplete="current-password" required /></label>
            <div className={styles.actions}><button className={styles.primary} value="Approved" disabled={busy}>Approve</button>
              <button value="Rejected" disabled={busy}>Reject</button></div>
          </form>:<p>{status==="Needs manager decision"?"Waiting for a supervisor.":check.route==="routine"?"Within store policy.":"Approval unavailable."}</p>}
      </>}
      {step==="execution"&&<>
        <h3>Execution</h3>
        {response ? <><p>{response.kind==="PayPal refund recovered"?"Recovered PayPal refund reference":name+" response"} · {response.refund.status??"Reference recorded"} · {response.refund.id}</p>
          <Link href={url(record.id,"receipt")}>Open receipt</Link></>:
          !connected ? <p>PayPal not connected</p>:
          provider&&!stopped&&(status==="Ready for "+name+" Sandbox refund"||(attempt&&(provider!=="square"||review?.decision==="Approved")))?<>
            <p>{attempt ? provider==="paypal" ? "Look up the original attempt in PayPal." :
              "Square’s response is unavailable. Retrying uses the original attempt." : "Submit this refund to "+name+" Sandbox."}</p>
            <button className={styles.primary} disabled={busy} onClick={()=>void run(async()=>{
              const result=await api<RefundRequest>({action:attempt&&provider==="paypal"?"verifyElectronicRefund":"executeElectronicRefund",id:record.id});
              setRecord(result);
              if(providerResponse(result)||executionStopped(result))router.push(url(record.id,"receipt"));
              else if(currentStep(result)==="approval")router.push(url(record.id,"approval"));
              else if(attempt&&provider==="paypal")setNotice("PayPal has not confirmed the original refund. The amount stays reserved.");
            })}>{attempt ? provider==="paypal"?"Reconcile original attempt":"Retry original attempt" : "Execute "+name+" Sandbox refund"}</button></>:
          reported ? <p>Test cash payout reported by {reported.actor} · {time(reported.occurredAt)}</p>:
          status==="Ready for cash payout"?<><p>Record a test cash payout after confirming the amount. This records an employee report.</p>
            <button className={styles.primary} disabled={busy} onClick={()=>void run(async()=>{
              const result=await api<RefundRequest>({action:"reportCashPayout",id:record.id});
              setRecord(result);router.push(url(record.id,"receipt"));
            })}>Record test cash payout</button></>:
          status==="Blocked · Processor not connected"?<><p><strong>Payment processor not connected</strong></p><p>No attempt, provider reference, or provider response exists.</p></>:
          <p>{check.explanation} {status==="Needs manager decision"?"Wait for the supervisor’s decision.":"No payout was submitted."}</p>}
      </>}
      {step==="receipt"&&<>
        <h3>Receipt and verification</h3>
        {provider?<><p>{response?.kind==="PayPal refund recovered" ? "Recovered original PayPal refund reference." :
          response ? response.refund.status ? name+" returned "+response.refund.status : name+" refund reference recorded." :
          attempt && !stopped ? name+" response unavailable." : "No "+name+" refund recorded."}</p>
          {stopped&&<p>{stopped.reason}</p>}
          {review&&<p>{review.decision} by {review.actor} · {time(review.occurredAt)}</p>}
          <p><strong>{verification?.result??"Independent lookup not run"}</strong>{verification?.occurredAt&&" · "+time(verification.occurredAt)}</p>
          {verification?.refund&&<dl className={styles.facts}>
            <div><dt>{name} refund ID</dt><dd>{verification.refund.id}</dd></div>
            <div><dt>{provider==="paypal"?"Original PayPal capture":"Original Square payment"}</dt><dd>{verification.refund.paymentId}</dd></div>
            <div><dt>Provider amount</dt><dd>{(verification.refund.amountCents/100).toFixed(2)} {verification.refund.currency}</dd></div>
            <div><dt>Provider status</dt><dd>{verification.refund.status}</dd></div>
          </dl>}
          {verification?.result==="Mismatch"&&<p>The provider readback did not match the approved refund. The outcome is unconfirmed.</p>}
          {!connected&&!verified&&!failed&&<p>PayPal not connected</p>}
          {connected&&response&&!verified&&!failed&&<button disabled={busy} onClick={()=>void run(async()=>
            setRecord(await api<RefundRequest>({action:"verifyElectronicRefund",id:record.id})))}>Check {name} status</button>}
        </>:!approvedDemo&&<>
          <p>{reported ? "Cash payout recorded. This is a test employee report." : "No payout or provider submission recorded."}</p>
          <p>Independent electronic readback unavailable. No electronic refund has been verified.</p>
        </>}
        <button type="button" className={styles.primary} onClick={()=>{
          const href=URL.createObjectURL(new Blob([JSON.stringify(requestReceipt(record),null,2)+"\n"],{type:"application/json"}));
          const anchor=document.createElement("a");anchor.href=href;anchor.download="changegate-refund-"+record.id+".json";anchor.click();
          window.setTimeout(()=>URL.revokeObjectURL(href),1000);
        }}>Download request receipt</button>
        <RefundHistory request={record} alerts={alertStatus.map(alert=>({phase:alert.phase,
          advisory:alert.explanation?.status==="complete"?alert.explanation.summary:alert.advisory}))}/>
      </>}
    </section>
  </section>;
}
