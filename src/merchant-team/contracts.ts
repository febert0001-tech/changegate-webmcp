import { z } from "zod";
import { pilotCommands } from "./pilot-contracts";
import { drawerDispositions } from "./weekly-cash-review";
import { csvText, refundMapping, type CaseEvidence } from "./refund-csv";
import { dispositionOptions } from "./review-summary";
import { comparisonInput } from "./refund-comparison";
import { alertEndpoint, alertEnrollment } from "./refund-alerts";
import { demoSaleReference, refundTerms, usdAmount, type MerchantRole } from "./refund-requests";
import { discountCommand } from "./discount-contracts";
export { TeamError } from "./error";

const text = (max: number) => z.string().trim().min(1).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const id = z.uuid();
const drawerCount = z.number().int().min(0).max(999999999999);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const activeStatuses = ["Investigating", "Awaiting evidence"] as const;
export type CaseStatus = (typeof activeStatuses)[number] | "Resolved";

export const rosterSchema = z.array(z.strictObject({
  username: slug,
  name: text(120),
  merchantId: slug,
  merchantName: text(120),
  role: z.enum(["cashier","manager","owner","reviewer"]).optional(),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  passwordHash: z.string().regex(/^[0-9a-f]{64}$/),
})).min(1).max(500).superRefine((roster, ctx) => {
  const usernames = new Set<string>();
  const merchants = new Map<string, string>();
  roster.forEach((member, index) => {
    if (usernames.has(member.username) ||
        (merchants.has(member.merchantId) && merchants.get(member.merchantId) !== member.merchantName)) {
      ctx.addIssue({ code: "custom", path: [index], message: "Inconsistent staff roster" });
    }
    usernames.add(member.username);
    merchants.set(member.merchantId, member.merchantName);
  });
});
export type Employee = z.infer<typeof rosterSchema>[number];

export const teamCommand = z.discriminatedUnion("action", [
  ...pilotCommands,
  z.strictObject({ action: z.literal("signIn"), username: slug, password: z.string().min(1).max(160), recoverSession: z.literal(true).optional() }),
  z.strictObject({ action: z.literal("signOut") }),
  z.strictObject({ action: z.literal("session") }),
  z.strictObject({ action: z.literal("workspace"), id: id.optional() }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("open"), id }),
  z.strictObject({ action: z.literal("create"), reference: text(160) }),
  z.strictObject({ action: z.literal("record"), id, revision, finding: text(1200), nextAction: text(1200),
    status: z.enum(activeStatuses) }),
  z.strictObject({ action: z.literal("assign"), id, revision, assignee: slug }),
  z.strictObject({ action: z.literal("note"), id, revision, note: text(1600) }),
  z.strictObject({ action: z.literal("resolve"), id, revision, drawerDisposition: z.enum(drawerDispositions).optional() }),
  z.strictObject({ action: z.literal("inspectCsv"), text: csvText }),
  z.strictObject({ action: z.literal("previewCsv"), text: csvText, mapping: refundMapping }),
  z.strictObject({ action: z.literal("importCsv"), text: csvText, mapping: refundMapping }),
  z.strictObject({ action: z.literal("previewComparison"), input: comparisonInput }),
  z.strictObject({ action: z.literal("saveComparison"), input: comparisonInput }),
  z.strictObject({ action: z.literal("reviewSummary"), id }),
  z.strictObject({ action: z.literal("recordDisposition"), id, findingId: id,
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    disposition: z.enum(dispositionOptions), note: text(1600) }),
  z.strictObject({ action: z.literal("refundAlertSettings") }),
  z.strictObject({ action: z.literal("enrollRefundAlerts"), enrollment: alertEnrollment }),
  z.strictObject({ action: z.literal("removeRefundAlerts"), endpoint: alertEndpoint }),
  z.strictObject({ action: z.literal("refundAlertStatus"), id, includeExplanation: z.literal(true).optional(),
    includeSavedExplanation: z.literal(true).optional() }),
  z.strictObject({ action: z.literal("lookupOriginalSale"), reference: text(160), source: z.enum(["test", "square", "paypal"]).optional() }),
  z.strictObject({ action: z.literal("executeElectronicRefund"), id }),
  z.strictObject({ action: z.literal("verifyElectronicRefund"), id }),
  z.strictObject({ action: z.literal("refundPolicy") }),
  z.strictObject({ action: z.literal("refundPolicyHistory") }),
  z.strictObject({ action: z.literal("previewSyntheticRefundWeek"), thresholdCents: z.number().int().min(0).max(999999999999) }),
  z.strictObject({ action: z.literal("previewRefundThreshold"), location: text(200),
    shift: text(200).optional(), week: z.iso.date().optional(), prepareChange: z.literal(true).optional(),
    thresholdCents: z.number().int().min(0).max(999999999999) })
    .refine(({ shift, week }) => (shift === undefined) !== (week === undefined)),
  z.strictObject({ action: z.literal("setRefundPolicy"), previewId: id }),
  z.strictObject({ action: z.literal("reportCashPayout"), id }),
  z.strictObject({ action: z.literal("cashDrawers"), id: id.optional(), register: z.literal("harbor-bar").optional() }),
  z.strictObject({ action: z.literal("overnightDesk"), id: id.optional() }),
  z.strictObject({ action: z.literal("overnightOwner"), replay: id.optional() }),
  z.strictObject({ action: z.literal("startOvernightReplay"), id }),
  z.strictObject({ action: z.literal("coverageSettings") }),
  z.strictObject({ action: z.literal("grantCoverage"), id, location: text(120), reviewer: slug,
    start: z.string().max(16), end: z.string().max(16) }),
  z.strictObject({ action: z.literal("startDemoCoverage"), id, location: text(120), reviewer: slug }),
  z.strictObject({ action: z.literal("revokeCoverage"), id }),
  z.strictObject({ action: z.literal("claimOvernightCase"), id }),
  z.strictObject({ action: z.literal("reassignOvernightCase"), id, reviewer: slug, endedAt: z.iso.datetime() }),
  z.strictObject({ action: z.literal("requestOvernightFollowUp"), id, grantId: id, requestId: id, checked: text(1200), question: text(1200) }),
  z.strictObject({ action: z.literal("replyOvernight"), id, requestId: id, text: text(1200) }),
  z.strictObject({ action: z.literal("weeklyCashReview"), week: z.iso.date().optional(), location: text(120).optional(), replay: id.optional() }),
  z.strictObject({ action: z.literal("openCashDrawer"), id, cents: drawerCount, register: z.literal("harbor-bar").optional() }),
  z.strictObject({ action: z.literal("closeCashDrawer"), id, cents: drawerCount }),
  z.strictObject({ action: z.literal("recordDrawerMovement"), id, entryId: id,
    kind: z.enum(["addition", "removal"]), cents: drawerCount.min(1), note: text(240) }),
  z.strictObject({ action: z.literal("recordDrawerFollowUp"), id, entryId: id, cents: drawerCount.nullable(), note: text(240) }),
  z.strictObject({ action: z.literal("openDrawerCase"), id }),
  z.strictObject({ action: z.literal("listRefundRequests") }),
  z.strictObject({ action: z.literal("demoShift") }),
  z.strictObject({ action: z.literal("shiftOverview"), manual: z.literal(true).optional() }),
  z.strictObject({ action: z.literal("recordDemoSale"), submissionId: id, amount: usdAmount,
    tender: z.enum(["Cash", "Electronic"]) }),
  z.strictObject({ action: z.literal("openDemoSale"), reference: demoSaleReference }),
  z.strictObject({ action: z.literal("demoDiscount"), command: discountCommand }),
  z.strictObject({ action: z.literal("replayHeldDemoRefund"), runId: id.nullable() }),
  z.strictObject({ action: z.literal("startDemoShift"), seed: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/) }),
  z.strictObject({ action: z.literal("nextDemoEvent"), runId: id, step: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal("replayDemoShift"), runId: id }),
  z.strictObject({ action: z.literal("openRefundRequest"), id }),
  z.strictObject({ action: z.literal("createRefundRequest"), submissionId: id, terms: refundTerms, demoRun: id.optional() }),
  z.strictObject({ action: z.literal("decideRefundRequest"), id, decision: z.enum(["Approved","Rejected"]), password: z.string().min(1).max(160) }),
  z.strictObject({ action: z.literal("listImports") }),
  z.strictObject({ action: z.literal("openImport"), id }),
  z.strictObject({ action: z.literal("assignFinding"), id, assignee: slug }),
]);
export type TeamCommand = z.infer<typeof teamCommand>;

export type HistoryKind = "Opened" | "Recorded finding" | "Assigned" | "Added note" | "Resolved" | "Imported evidence" |
  "Coverage claimed" | "Owner follow-up requested" | "Owner replied" | "Reviewer shift ended" | "Coverage reassigned" | "Pilot disposition" | "Pilot missed issue";
export interface CaseHistory {
  sequence: number;
  actor: string;
  username: string;
  kind: HistoryKind;
  detail: string;
  occurredAt: string;
}
export interface TeamCase {
  id: string;
  reference: string;
  revision: number;
  assignee: string;
  assigneeName: string;
  status: CaseStatus;
  finding: string;
  nextAction: string;
  updatedAt: string;
  differenceCents?: number;
}
export interface TeamCaseDetail {
  case: TeamCase;
  history: CaseHistory[];
  evidence?: CaseEvidence;
  drawerId?: string;
  overnightReplayId?: string;
}
export interface TeamSession {
  sessionVersion: string;
  username: string;
  name: string;
  merchantName: string;
  role?: MerchantRole;
  reviewerConfigured?: boolean;
  paypalConnected?: boolean;
  demoShift?: boolean;
  demoDiscountEnabled?: boolean;
  demoRegister?: { location: string; register: string };
  syntheticOnly?: boolean;
  demoInviteAdmin?: boolean;
  demoInviteIdentityRequired?: boolean;
  pilotEnabled?: boolean;
  coworkers: { username: string; name: string }[];
}

export interface TeamWorkspaceView {
  session: TeamSession;
  cases: TeamCase[];
  detail: TeamCaseDetail | null;
}
