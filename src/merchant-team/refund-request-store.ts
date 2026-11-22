import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { TeamError } from "./error";
import { canReview, cents, checks, money, payout, requestDecision, requestStatus, testSale,
  type RefundCheck, type RefundDecision, type RefundRequest, type RefundTerms, type TestSale, type TransactionEvent } from "./refund-requests";

type RequestRow = { id: string; terms: string; sale: string; events: string };
const project = (row: RequestRow): RefundRequest => ({
  id: row.id, terms: JSON.parse(row.terms), sale: JSON.parse(row.sale), events: JSON.parse(row.events),
});
export class RefundRequestStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_refund_policy (merchant_id TEXT PRIMARY KEY, threshold_cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_refund_requests (
        merchant_id TEXT NOT NULL, id TEXT NOT NULL, submission_id TEXT NOT NULL, requester TEXT NOT NULL,
        terms TEXT NOT NULL, sale TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (merchant_id, id), UNIQUE (merchant_id, submission_id)
      );
      CREATE TABLE IF NOT EXISTS team_refund_request_events (
        sequence INTEGER PRIMARY KEY, merchant_id TEXT NOT NULL, request_id TEXT NOT NULL,
        username TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY (merchant_id, request_id) REFERENCES team_refund_requests(merchant_id, id)
      );
      CREATE INDEX IF NOT EXISTS team_request_events_by_id ON team_refund_request_events(merchant_id, request_id, sequence);
    `);
  }

  private select() {
    return `SELECT r.id,r.terms,r.sale,
      (SELECT json_group_array(json(e.payload)) FROM (
        SELECT payload FROM team_refund_request_events WHERE merchant_id=r.merchant_id AND request_id=r.id ORDER BY sequence
      ) e) AS events FROM team_refund_requests r`;
  }
  list(employee: Employee) {
    return (this.db.prepare(this.select()+" WHERE r.merchant_id=? ORDER BY r.created_at DESC,r.id")
      .all(employee.merchantId) as unknown as RequestRow[]).map(project);
  }
  open(employee: Employee, id: string) {
    const row = this.db.prepare(this.select()+" WHERE r.merchant_id=? AND r.id=?").get(employee.merchantId,id) as RequestRow | undefined;
    if (!row) throw new TeamError("TRANSACTION_NOT_FOUND",404);
    return project(row);
  }

  policy(employee: Employee) {
    const row=this.db.prepare("SELECT threshold_cents AS threshold FROM team_refund_policy WHERE merchant_id=?").get(employee.merchantId);
    return { thresholdCents: typeof row?.threshold === "number" ? row.threshold : 5000 };
  }
  setPolicy(employee: Employee, thresholdCents: number) {
    if (employee.role !== "owner") throw new TeamError("TRANSACTION_ROLE_REQUIRED",403);
    this.db.prepare(`INSERT INTO team_refund_policy VALUES (?,?) ON CONFLICT(merchant_id)
      DO UPDATE SET threshold_cents=excluded.threshold_cents`).run(employee.merchantId,thresholdCents);
    return this.policy(employee);
  }
  private saleUsage(employee: Employee, sale: TestSale) {
    let paidCents=0, reservedCents=0;
    const rows=(this.db.prepare(this.select()+" WHERE r.merchant_id=? AND json_extract(r.terms,'$.reference')=?")
      .all(employee.merchantId,sale.reference) as unknown as RequestRow[]).map(project);
    for (const request of rows) {
      if (checks(request).route === "over-balance" || requestDecision(request)?.decision === "Rejected") continue;
      if (payout(request)) paidCents+=cents(request.terms.amount); else reservedCents+=cents(request.terms.amount);
    }
    return { paidCents, reservedCents, balanceCents:sale.originalCents-sale.priorCents-paidCents-reservedCents };
  }
  lookup(employee: Employee, reference: string) {
    const sale=testSale(reference);
    return sale ? {sale,...this.saleUsage(employee,sale)} : null;
  }
  create(employee: Employee, submissionId: string, terms: RefundTerms) {
    const payload = JSON.stringify(terms);
    const existing = this.db.prepare("SELECT id,terms FROM team_refund_requests WHERE merchant_id=? AND submission_id=?")
      .get(employee.merchantId,submissionId);
    if (typeof existing?.id === "string") {
      if (existing.terms !== payload) throw new TeamError("TRANSACTION_SUBMISSION_CHANGED",409);
      return this.open(employee,existing.id);
    }
    const id=randomUUID(), occurredAt=this.now(), sale=testSale(terms.reference);
    const { thresholdCents }=this.policy(employee);
    let check: RefundCheck;
    if (!sale) {
      check={route:"exception",balanceCents:null,cumulativeCents:null,thresholdCents,
        explanation:"The sale could not be verified. Route it to a manager for exception review. Payment remains blocked."};
    } else {
      const { balanceCents }=this.saleUsage(employee,sale);
      const amount=cents(terms.amount);
      const cumulativeCents=sale.originalCents-balanceCents+amount;
      const recent = this.db.prepare(`SELECT terms FROM team_refund_requests
        WHERE merchant_id=? AND requester=? AND created_at>=?`).all(employee.merchantId,employee.username,
          new Date(Date.parse(occurredAt)-15*60*1000).toISOString()) as {terms:string}[];
      const repeated = recent.some(row => {
        const prior=JSON.parse(row.terms) as RefundTerms;
        return prior.reference===terms.reference && cents(prior.amount)===amount;
      });
      const base={ balanceCents,cumulativeCents,thresholdCents };
      if (amount>balanceCents) check={...base,route:"over-balance",explanation:"Only "+money(balanceCents)+" remains refundable. This request is blocked."};
      else if (cumulativeCents>thresholdCents) check={...base,route:"manager",
        explanation:"This request would bring refunds on this sale to "+money(cumulativeCents)+", above the store’s "+money(thresholdCents)+" approval threshold."};
      else if (repeated || recent.length>=3) check={...base,route:"manager",
        explanation:repeated ? "The employee submitted the same amount for this sale in the last 15 minutes. Review whether it is a repeat."
          : "This is the employee’s fourth or later refund request in 15 minutes. Review the recent activity."};
      else check={...base,route:"routine",explanation:"The request fits the remaining balance and the store’s cumulative approval threshold."};
    }
    this.db.prepare("INSERT INTO team_refund_requests VALUES (?,?,?,?,?,?,?)")
      .run(employee.merchantId,id,submissionId,employee.username,payload,JSON.stringify(sale),occurredAt);
    this.add(employee,id,{kind:"Request submitted",actor:employee.name,occurredAt});
    this.add(employee,id,{kind:"Checks recorded",actor:"ChangeGate",occurredAt,check});
    return this.open(employee,id);
  }

  decide(employee: Employee, id: string, decision: RefundDecision) {
    const request=this.open(employee,id);
    if (!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED",403);
    const requester=this.db.prepare("SELECT requester FROM team_refund_requests WHERE merchant_id=? AND id=?").get(employee.merchantId,id);
    if (requester?.requester===employee.username) throw new TeamError("TRANSACTION_SELF_REVIEW",403);
    const previous=requestDecision(request);
    if (previous?.decision===decision) return request;
    if (previous) throw new TeamError("TRANSACTION_DECIDED",409);
    const route=checks(request).route;
    if (route!=="manager"&&route!=="exception") throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE",409);
    this.add(employee,id,{kind:"Decision recorded",actor:employee.name,occurredAt:this.now(),decision});
    return this.open(employee,id);
  }

  reportCash(employee: Employee,id: string) {
    const request=this.open(employee,id);
    if (payout(request)) return request;
    if (requestStatus(request)!=="Ready for cash payout") throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE",409);
    this.add(employee,id,{kind:"Cash payout reported",actor:employee.name,occurredAt:this.now()});
    return this.open(employee,id);
  }

  private add(employee: Employee, id: string, event: TransactionEvent) {
    this.db.prepare("INSERT INTO team_refund_request_events (merchant_id,request_id,username,payload) VALUES (?,?,?,?)")
      .run(employee.merchantId,id,employee.username,JSON.stringify(event));
  }
}
