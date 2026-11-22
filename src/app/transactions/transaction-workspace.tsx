"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { TeamCommand, TeamSession } from "../../merchant-team/contracts";
import { canReview, cents, checks, currentStep, executionStopped, money, payout, requestDecision, requestReceipt,
  squareAttempt, squareResponse, squareVerification,
  requestStatus, submitted, transactionTabs, type RefundRequest, type TestSale, type TransactionStep } from "../../merchant-team/refund-requests";
import { PhoneAlerts } from "./phone-alerts";
import { useTransactionTools } from "./use-transaction-tools";
import styles from "../merchant/merchant.module.css";

type Send = <T>(command: TeamCommand, options?: { signal?: AbortSignal; sessionVersion?: string }) => Promise<T>;
type Lookup = { sale: TestSale; paidCents: number; reservedCents: number; balanceCents: number } | null;
const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const url = (id: string, step?: TransactionStep) => "/transactions/" + id + (step ? "/" + step : "");
const time = (value: string) => value.replace("T"," ").slice(0,19) + " UTC";

function SaleFacts({ sale }: { sale: TestSale }) {
  return <dl className={styles.facts}>
    <div><dt>Location</dt><dd>{sale.location}</dd></div>
    <div><dt>Register</dt><dd>{sale.register}</dd></div>
    <div><dt>Shift</dt><dd>{sale.shift}</dd></div>
    <div><dt>Original sale</dt><dd>{money(sale.originalCents)}</dd></div>
    <div><dt>{sale.square?"Square refunds completed or pending":"Prior refunds on test sale"}</dt><dd>{money(sale.priorCents)}</dd></div>
    <div><dt>Sale source</dt><dd>{sale.square?"Square Sandbox":"ChangeGate test fixture"}</dd></div>
    <div><dt>Original tender</dt><dd>{sale.tender}</dd></div>
  </dl>;
}
export function TransactionWorkspace({destination,session,send,onSessionError}: {
  destination:"list"|{id:string;step:TransactionStep}; session:TeamSession; send:Send; onSessionError:(e:unknown)=>boolean;
}) {
  const router=useRouter();
  const [rows,setRows]=useState<RefundRequest[]>([]);
  const [record,setRecord]=useState<RefundRequest>();
  const [alertStatus,setAlertStatus]=useState<{phase:number;status:string;advisory:string|null}[]>([]);
  const [threshold,setThreshold]=useState<number>();
  const [query,setQuery]=useState("");
  const [location,setLocation]=useState("");
  const [register,setRegister]=useState("");
  const [shift,setShift]=useState("");
  const [employee,setEmployee]=useState("");
  const [newForm,setNewForm]=useState(false);
  const [reference,setReference]=useState("");
  const [source,setSource]=useState<"test"|"square">("test");
  const [lookup,setLookup]=useState<Lookup>();
  const [formId,setFormId]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const id=destination==="list" ? undefined : destination.id;
  const version=session.sessionVersion;
  const manager=canReview(session.role);
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
            send<{phase:number;status:string;advisory:string|null}[]>({action:"refundAlertStatus",id},options),
          ]);
          if(!controller.signal.aborted){setRecord(result);setAlertStatus(alerts);}
        }else{
          const result=await send<RefundRequest[]>({action:"listRefundRequests"},options);
          if(!controller.signal.aborted)setRows(result);
        }
      }catch(e){
        if(!controller.signal.aborted&&!onSessionError(e))setError(e instanceof Error?e.message:"Transactions unavailable.");
      }finally{
        running=false;
        if(!controller.signal.aborted)setLoading(false);
      }
    }
    void load();
    if(!id&&session.role==="owner")void send<{thresholdCents:number}>({action:"refundPolicy"},options)
      .then(result=>{if(!controller.signal.aborted)setThreshold(result.thresholdCents);})
      .catch(e=>{if(!controller.signal.aborted&&!onSessionError(e))setError("Could not load the refund policy.");});
    const timer=id||manager ? window.setInterval(()=>{if(document.visibilityState==="visible")void load();},5000):undefined;
    return()=>{controller.abort();if(timer!==undefined)window.clearInterval(timer);};
  },[id,manager,onSessionError,send,session.role,version]);

  async function run(work:()=>Promise<void>){
    setBusy(true);setError("");setNotice("");
    try{await work();}catch(e){if(!onSessionError(e))setError(e instanceof Error?e.message:"Transaction unavailable.");}
    finally{setBusy(false);}
  }
  const api=<T,>(command:TeamCommand)=>send<T>(command,{sessionVersion:version});
  const noticeBlock=<>{error&&<p className={styles.formError} role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</>;
  if(destination==="list"){
    const pending=rows.filter(r=>requestStatus(r)==="Needs manager decision");
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
        <button className={styles.primary} type="button" onClick={()=>{
          setNewForm(true);setReference("");setSource("test");setLookup(undefined);setFormId(crypto.randomUUID());setError("");
        }}>New refund</button></div>
      {session.reviewerConfigured===false&&<p className={styles.formError}>No supervisor is configured for this store. Ask your store administrator to assign a manager or owner.</p>}
      <p className={styles.fieldHint}>Test environment · ChangeGate fixtures and Square Sandbox</p>
      {noticeBlock}
      {newForm&&<section className={styles.importSection} aria-label="New refund">
        <h3>Find original sale</h3>
        <form className={styles.formRow} onSubmit={event=>{
          event.preventDefault();
          void run(async()=>setLookup(await api<Lookup>({action:"lookupOriginalSale",reference,source})));
        }}>
          <label>Sale source<select name="saleSource" value={source} disabled={busy} onChange={e=>{
            setSource(e.target.value==="square"?"square":"test");setReference("");setLookup(undefined);setError("");
            setFormId(crypto.randomUUID());
          }}><option value="test">ChangeGate test records</option><option value="square">Square Sandbox</option></select></label>
          <label>Original payment reference<input name="reference" value={reference} maxLength={160} required disabled={busy}
            onChange={e=>{setReference(e.target.value);setLookup(undefined);setFormId(crypto.randomUUID());}} /></label>
          <button type="submit" disabled={busy}>Find sale</button>
        </form>
        {source==="test"&&<p className={styles.fieldHint}>Test references: TEST-SALE-CASH, TEST-SALE-BALANCE, TEST-SALE-PARTIAL, TEST-SALE-ELECTRONIC, TEST-MONITOR-1 through 6</p>}
        {lookup!==undefined&&<>
          {lookup ? <><SaleFacts sale={lookup.sale} /><p><strong>{money(lookup.balanceCents)} remaining refundable</strong>
            {" · "+money(lookup.paidCents)+" reported here · "+money(lookup.reservedCents)+" reserved"}</p></>:
            <p className={styles.formError}>Sale could not be verified. Submit it for manager exception review.</p>}
          <form onSubmit={event=>{
            event.preventDefault();
            const form=new FormData(event.currentTarget);
            void run(async()=>{
              const result=await api<RefundRequest>({action:"createRefundRequest",submissionId:formId,terms:{
                ...(source==="square"&&{source}),reference,amount:value(form,"amount"),currency:"USD",reason:value(form,"reason"),
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
        <PhoneAlerts api={api}/><p role="status">{pending.length} {pending.length===1?"request needs":"requests need"} a decision</p>
        {!!pending.length&&list(pending)}
        {!!overBalance.length&&<details><summary>{overBalance.length} over-balance {overBalance.length===1?"request":"requests"} blocked</summary>
          {list(overBalance.slice(0,10))}</details>}
      </section>}
      {session.role==="owner"&&<section className={styles.importSection}>
        <h3>Owner activity</h3>
        {threshold!==undefined&&<form className={styles.formRow} onSubmit={event=>{
          event.preventDefault();
          const amount=value(new FormData(event.currentTarget),"threshold");
          void run(async()=>{
            if(!/^\d{1,10}(\.\d{1,2})?$/.test(amount))throw Error("Enter a USD amount with up to two decimal places.");
            const result=await api<{thresholdCents:number}>({action:"setRefundPolicy",thresholdCents:cents(amount)});
            setThreshold(result.thresholdCents);setNotice("Approval threshold saved.");
          });
        }}>
          <label>Cumulative manager approval threshold (USD)<input name="threshold" key={threshold} inputMode="decimal"
            defaultValue={(threshold/100).toFixed(2)} required /></label>
          <button disabled={busy}>Save threshold</button>
        </form>}
        <div className={styles.importMapping}>{([
          ["Location",location,setLocation,rows.map(r=>r.sale?.location)],
          ["Register",register,setRegister,rows.map(r=>r.sale?.register)],
          ["Shift",shift,setShift,rows.map(r=>r.sale?.shift)],
          ["Employee",employee,setEmployee,rows.map(r=>submitted(r).actor)],
        ] as const).map(([label,selected,set,items])=><label key={label}>{label}<select value={selected} onChange={e=>set(e.target.value)}>
          <option value="">All</option>{[...new Set(items.filter(Boolean))].map(item=><option key={item}>{item}</option>)}
        </select></label>)}</div>
      </section>}
      <section className={styles.importSection}><h3>Refund activity</h3>
        <label>Search transactions<input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
        {loading?<p>Loading transactions…</p>:filtered.length?list(filtered):<p className={styles.emptyState}>No matching transactions.</p>}
      </section>
    </section>;
  }

  if(!record)return <section className={styles.card}>{noticeBlock}{loading&&<p>Loading refund…</p>}</section>;
  const {step}=destination;
  const review=requestDecision(record), check=checks(record), reported=payout(record);
  const stopped=executionStopped(record);
  const square=record.sale?.square, attempt=squareAttempt(record), response=squareResponse(record), verification=squareVerification(record);
  const verified=verification?.result==="Verified", failed=verification?.result==="Failed";
  const status=requestStatus(record), current=currentStep(record);
  const outcome=verified ? "Square Sandbox refund verified · No real money moved"
    : failed ? "Square Sandbox reports the refund failed"
    : attempt ? "Square Sandbox outcome unconfirmed"
    : reported ? "Test cash payout reported" : "No payout recorded";
  const next=status==="Needs manager decision" ? "A different supervisor must approve or reject this request."
    : check.route==="over-balance" ? "Cashier: check the balance and start a new request for an eligible amount."
    : review?.decision==="Rejected" ? "No payout action is available. Return to the transaction list."
    : stopped ? stopped.reason
    : status==="Ready for cash payout" ? "Cashier: confirm and record the test cash payout in Execution."
    : reported ? "Cashier: open the receipt for the recorded employee report."
    : verified || failed ? "Open the receipt for Square’s independent readback."
    : response ? "Check the receipt for the latest Square status."
    : attempt ? "Retry the original Square attempt from Execution."
    : square ? "Execute the refund in Square Sandbox."
    : "Execution is blocked until a payment processor is connected.";
  return <section className={styles.card} aria-labelledby="refund-heading">
    <div className={styles.screenHeading}><h2 id="refund-heading">Refund · {money(cents(record.terms.amount))}</h2><Link href="/transactions">All transactions</Link></div>
    <p className={styles.caseReference}>{record.terms.reference} · {record.sale?.location??"Sale unverified"} · {square?"Square Sandbox":"Test data"}</p>
    <section className={styles.transactionSummary} aria-label="Refund status and next action">
      <p className={styles.statusHeading}><strong>{status}</strong><span>Current step · {transactionTabs.find(([tab])=>tab===current)?.[1]}</span></p>
      <dl className={styles.moneySummary}>
        <div><dt>Requested</dt><dd>{money(cents(record.terms.amount))}</dd></div>
        <div><dt>Refundable at request</dt><dd>{check.balanceCents===null?"Unavailable":money(check.balanceCents)}</dd></div>
        <div><dt>Money movement</dt><dd>{outcome}</dd></div>
      </dl>
      <p><strong>Next action</strong> {next}</p>
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
          <li>{square?"Square confirmed a completed USD card sale for the configured merchant and location.":
            record.sale?"Original sale found in the test POS records.":"Original sale could not be verified."}</li>
          <li>Remaining refundable balance {check.balanceCents===null?"unavailable":money(check.balanceCents)}</li>
          <li>Store approval threshold {money(check.thresholdCents)}</li>
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
        <p><strong>Reason</strong> {record.terms.reason}</p><p><strong>Why it stopped</strong> {check.explanation}</p>
        {alertStatus.map(alert=><div key={alert.phase}>
          <p>{alert.phase===0?"Primary":"Backup"} alert · {alert.status}</p>
          {alert.advisory&&<p>AI advisory: {alert.advisory}</p>}
        </div>)}
        {review?<p><strong>{review.decision}</strong> by {review.actor} · {time(review.occurredAt)}</p>:
          status==="Needs manager decision"&&manager ? <form onSubmit={event=>{
            event.preventDefault();
            const native=event.nativeEvent as SubmitEvent;
            const decision=(native.submitter as HTMLButtonElement|null)?.value;
            if(decision!=="Approved"&&decision!=="Rejected")return;
            const form = event.currentTarget;
            const password = String(new FormData(form).get("supervisorPassword") ?? "");
            form.reset();
            void run(async()=>{
              const result=await api<RefundRequest>({action:"decideRefundRequest",id:record.id,decision,password});
              setRecord(result);setNotice("Decision saved.");
              router.push(url(record.id,currentStep(result)));
            });
          }}>
            <label>Confirm with your password<input name="supervisorPassword" type="password" autoComplete="current-password" required /></label>
            <div className={styles.actions}><button className={styles.primary} value="Approved" disabled={busy}>Approve</button>
              <button value="Rejected" disabled={busy}>Reject</button></div>
          </form>:<p>{status==="Needs manager decision"?"Waiting for a supervisor.":check.route==="routine"?"Within store policy.":"Approval unavailable."}</p>}
      </>}
      {step==="execution"&&<>
        <h3>Execution</h3>
        {response ? <><p>Square response · {response.refund.status} · {response.refund.id}</p>
          <Link href={url(record.id,"receipt")}>Open receipt</Link></>:
          square&&(status==="Ready for Square Sandbox refund"||attempt)?<>
            <p>{attempt?"Square’s response is unavailable. Retrying uses the original attempt.":"Submit this refund to Square Sandbox."}</p>
            <button className={styles.primary} disabled={busy} onClick={()=>void run(async()=>{
              const result=await api<RefundRequest>({action:"executeSquareRefund",id:record.id});
              setRecord(result);
              if(squareResponse(result)||executionStopped(result))router.push(url(record.id,"receipt"));
              else if(currentStep(result)==="approval")router.push(url(record.id,"approval"));
            })}>{attempt?"Retry original attempt":"Execute Square Sandbox refund"}</button></>:
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
        {square?<><p>{response ? "Square returned "+response.refund.status : attempt ? "Square response unavailable." : "No Square submission recorded."}</p>
          {stopped&&<p>{stopped.reason}</p>}
          {review&&<p>{review.decision} by {review.actor} · {time(review.occurredAt)}</p>}
          <p><strong>{verification?.result??"Independent lookup not run"}</strong>{verification?.occurredAt&&" · "+time(verification.occurredAt)}</p>
          {verification?.refund&&<dl className={styles.facts}>
            <div><dt>Square refund ID</dt><dd>{verification.refund.id}</dd></div>
            <div><dt>Original Square payment</dt><dd>{verification.refund.paymentId}</dd></div>
            <div><dt>Provider amount</dt><dd>{(verification.refund.amountCents/100).toFixed(2)} {verification.refund.currency}</dd></div>
            <div><dt>Provider status</dt><dd>{verification.refund.status}</dd></div>
          </dl>}
          {verification?.result==="Mismatch"&&<p>Square’s readback did not match the approved refund. The outcome is unconfirmed.</p>}
          {response&&!verified&&!failed&&<button disabled={busy} onClick={()=>void run(async()=>
            setRecord(await api<RefundRequest>({action:"verifySquareRefund",id:record.id})))}>Check Square status</button>}
        </>:<>
          <p>{reported ? "Cash payout recorded. This is a test employee report." : "No payout or provider submission recorded."}</p>
          <p>Independent electronic readback unavailable. No electronic refund has been verified.</p>
        </>}
        <button type="button" className={styles.primary} onClick={()=>{
          const href=URL.createObjectURL(new Blob([JSON.stringify(requestReceipt(record),null,2)+"\n"],{type:"application/json"}));
          const anchor=document.createElement("a");anchor.href=href;anchor.download="changegate-refund-"+record.id+".json";anchor.click();
          window.setTimeout(()=>URL.revokeObjectURL(href),1000);
        }}>Download request receipt</button>
        <ol className={styles.rejections}>{record.events.map((event,index)=><li key={index}>{event.kind} · {event.actor} · {time(event.occurredAt)}</li>)}</ol>
      </>}
    </section>
  </section>;
}
