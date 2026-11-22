import { sendNotification } from "web-push";
import { canReview } from "./refund-requests";
import { allowedPushEndpoint, alertPublicKey } from "./refund-alerts";
import type { Employee } from "./contracts";
import type { RefundAlertStore } from "./refund-alert-store";

export async function explainAlert(evidence:string, key:string, model:string) {
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},
    signal:AbortSignal.timeout(8000),body:JSON.stringify({model,store:false,max_output_tokens:180,
      instructions:"Summarize only the supplied numeric refund warning. Explain the rule evidence in one short sentence. Give no approval, accusation, or payment instruction.",
      input:evidence,text:{format:{type:"json_schema",name:"refund_advisory",strict:true,schema:{
        type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false,
      }}},
    }),
  });
  if(!response.ok) return null;
  const data=await response.json() as {status?:string;output?:{content?:{type?:string;text?:string}[]}[]};
  const output=data.output?.flatMap(item=>item.content??[]).find(item=>item.type==="output_text")?.text;
  if(data.status!=="completed"||!output)return null;
  const summary=(JSON.parse(output) as {summary?:unknown}).summary;
  return typeof summary==="string"&&summary.trim()?summary.trim().slice(0,500):null;
}

export function startRefundAlerts(store:RefundAlertStore, roster:readonly Employee[]) {
  const publicKey=alertPublicKey(),privateKey=process.env.CHANGEGATE_PUSH_PRIVATE_KEY,subject=process.env.CHANGEGATE_PUSH_SUBJECT;
  const aiKey=process.env.CHANGEGATE_MONITOR_AI_KEY,model=process.env.CHANGEGATE_MONITOR_AI_MODEL;
  const managers=new Map(roster.filter(member=>canReview(member.role)).map(member=>[member.username,member.merchantId]));
  let working=false;
  async function processOne() {
    if(working)return;
    working=true;
    try {
      const now=Date.now();
      const job=store.claim(now);
      if(!job)return;
      if(store.decided(job)){store.finish(job,"cancelled");return;}
      if(job.phase===0&&aiKey&&model&&store.markAi(job)){
        void explainAlert(job.alertEvidence,aiKey,model).then(note=>{
          if(note)store.saveAdvisory(job,note);
        }).catch(()=>{ /* Advisory failure cannot delay notifications or change approval. */ });
      }
      if(!publicKey||!privateKey||!subject){store.finish(job,"not configured");return;}
      if(store.decided(job)){store.finish(job,"cancelled");return;}
      const targets=store.recipients(job).filter(row=>managers.get(row.username)===job.merchantId &&
        allowedPushEndpoint(row.subscription.endpoint));
      const limited=targets.slice(0,25);
      const results=await Promise.all(limited.map(async ({subscription})=>{
        const {endpoint,keys}=subscription;
        try {
          await sendNotification({endpoint,keys},JSON.stringify({
            version:1,tag:"refund-"+job.requestId, path:"/transactions/"+job.requestId+(job.route==="over-balance"?"/checks":"/approval"),
            kind:job.route==="over-balance"?"blocked":job.phase===1?"escalated":"review",
          }),{vapidDetails:{subject,publicKey,privateKey},TTL:300,timeout:8000,urgency:"high"});
          store.sent(job,endpoint);
          return true;
        } catch(error) {
          const code=(error as {statusCode?:number})?.statusCode;
          if(code===404||code===410){store.retired(job,endpoint);return true;}
          return false;
        }
      }));
      if(!limited.length||targets.length>limited.length||results.some(success=>!success)){
        const expired=now-job.createdAt>=30*60_000;
        store.finish(job,expired?"delivery unavailable":"pending",now+30_000);
      }else{
        store.finish(job,store.hasSent(job)?"push accepted":"delivery unavailable");
      }
    } catch { console.error("Refund alert worker could not complete a job."); }
    finally { working=false; }
  }
  const timer=setInterval(()=>void processOne(),3000);
  timer.unref();
}
