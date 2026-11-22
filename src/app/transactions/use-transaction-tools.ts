"use client";
import { useEffect } from "react";
import { z } from "zod";
import type { TeamCommand } from "../../merchant-team/contracts";
import { checks, providerName, requestStatus, saleProvider, type RefundRequest } from "../../merchant-team/refund-requests";
import { getWebMcpModelContext } from "../../webmcp/native-contract";

type Read = (command: TeamCommand, signal: AbortSignal) => Promise<RefundRequest | RefundRequest[]>;
const inspect = (request: RefundRequest) => {
  const provider=saleProvider(request.sale);
  return {
    id:request.id, reference:request.terms.reference, amount:request.terms.amount, currency:request.terms.currency,
    status:requestStatus(request), checks:checks(request),
    dataSource:provider?providerName(provider)+" Sandbox":"Test sale records",
  };
};
export function useTransactionTools(read: Read) {
  useEffect(() => {
    const context=getWebMcpModelContext(document) ?? getWebMcpModelContext(navigator);
    if (!context) return;
    const controller=new AbortController();
    const options={signal:controller.signal};
    void (async () => {
      try {
        await context.registerTool({
          name:"list_refund_requests",description:"Read refund checks and statuses for the signed-in merchant. No transaction changes.",
          inputSchema:{type:"object",properties:{},additionalProperties:false},
          async execute(input, invocation) {
            z.strictObject({}).parse(input);
            const rows=await read({action:"listRefundRequests"},AbortSignal.any([options.signal,invocation.signal]));
            return (rows as RefundRequest[]).slice(0,100).map(inspect);
          },
        },options);
        if (controller.signal.aborted) return;
        await context.registerTool({
          name:"read_refund_request",description:"Read the checks and status of one refund request. No transaction changes.",
          inputSchema:{type:"object",properties:{id:{type:"string",format:"uuid"}},required:["id"],additionalProperties:false},
          async execute(input, invocation) {
            const {id}=z.strictObject({id:z.uuid()}).parse(input);
            return inspect(await read({action:"openRefundRequest",id},AbortSignal.any([options.signal,invocation.signal])) as RefundRequest);
          },
        },options);
      } catch { controller.abort(); }
    })();
    return () => controller.abort();
  },[read]);
}
