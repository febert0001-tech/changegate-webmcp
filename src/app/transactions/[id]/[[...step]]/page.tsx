import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { TeamError } from "../../../../merchant-team/error";
import { currentStep, transactionTabs } from "../../../../merchant-team/refund-requests";
import { teamWorkspace } from "../../../../merchant-team/runtime";
import { MerchantConsole } from "../../../merchant/merchant-console";

export const dynamic="force-dynamic";
export default async function TransactionPage({params}: {params:Promise<{id:string;step?:string[]}>}) {
  const {id,step=[]}=await params;
  if(!z.uuid().safeParse(id).success || step.length>1) notFound();
  const tab=transactionTabs.find(([key])=>key===step[0])?.[0];
  if(step.length && !tab) notFound();
  const workspace=teamWorkspace();
  const employee=workspace?.employeeFor(await headers());
  if(employee && workspace){
    let record;
    try { record=workspace.openRefundRequest(employee,id); }
    catch(error) {
      if(error instanceof TeamError && error.status===404) notFound();
      throw error;
    }
    if(!tab) redirect("/transactions/"+id+"/"+currentStep(record));
  }
  return <MerchantConsole transaction={{id,step:tab??"sale"}} />;
}
