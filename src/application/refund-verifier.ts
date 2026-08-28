// Internal construction API for trusted application composition only.
// Never include this factory in agent operations, UI props, or WebMCP tools.
export { createRefundVerifier } from "../domain/refund-verification";
export type { RefundVerificationEvidence, RefundVerifier } from "../domain/refund-verification";
