import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import type { RefundAlertStore } from "./refund-alert-store";
import { assessSize, individualLimitCents, repeatWatchThreshold, ruleVersion, syntheticRegisterDrift, watchWindowMs } from "./refund-monitor-rules";
import { TeamError } from "./error";
import { previewRefundThreshold, type RefundPolicyHistory, type RefundPreviewScope, type ThresholdPreview } from "./refund-threshold-preview";
import { addCashWeekDays, cashStoreDate, cashTimeZone, cashWeekMonday } from "./weekly-cash-review";
import { canReview, cents, checks, executionStopped, money, payout, providerName, providerResponse, providerVerification,
  requestDecision, requestStatus, routeVerifiedRefund, saleProvider, testSale, thresholdReason, type ElectronicAttemptTerms,
  type ElectronicSaleEvidence, type ProviderRefundEvidence, type ProviderRefundResponse, type RefundCheck,
  type RefundDecision, type RefundRequest, type RefundTerms, type RefundVerification, type RefundWatchEntry, type TestSale, type TransactionEvent } from "./refund-requests";

type RequestRow = { id: string; terms: string; sale: string; events: string };
const project = (row: RequestRow): RefundRequest => ({
  id: row.id, terms: JSON.parse(row.terms), sale: JSON.parse(row.sale), events: JSON.parse(row.events),
});
export class RefundRequestStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string, private readonly demoWorkspace = false) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_refund_policy (merchant_id TEXT PRIMARY KEY, threshold_cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_refund_policy_previews (
        merchant_id TEXT NOT NULL, username TEXT NOT NULL, id TEXT NOT NULL,
        location TEXT NOT NULL, revision INTEGER NOT NULL, old_cents INTEGER NOT NULL, new_cents INTEGER NOT NULL,
        PRIMARY KEY (merchant_id, username)
      );
      CREATE TABLE IF NOT EXISTS team_refund_policy_changes (
        sequence INTEGER PRIMARY KEY, merchant_id TEXT NOT NULL, preview_id TEXT NOT NULL,
        username TEXT NOT NULL, actor TEXT NOT NULL, location TEXT NOT NULL, effective_at TEXT NOT NULL,
        old_cents INTEGER NOT NULL, new_cents INTEGER NOT NULL, UNIQUE (merchant_id, preview_id)
      );
      CREATE INDEX IF NOT EXISTS team_refund_policy_changes_by_merchant ON team_refund_policy_changes(merchant_id, sequence);
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
      CREATE TABLE IF NOT EXISTS team_refund_watch (
        merchant_id TEXT NOT NULL, request_id TEXT NOT NULL, cashier TEXT NOT NULL, register_scope TEXT NOT NULL,
        seen_at TEXT NOT NULL, PRIMARY KEY(merchant_id,request_id),
        FOREIGN KEY(merchant_id,request_id) REFERENCES team_refund_requests(merchant_id,id)
      );
      CREATE INDEX IF NOT EXISTS team_refund_watch_cashier ON team_refund_watch(merchant_id,cashier,seen_at);
      CREATE INDEX IF NOT EXISTS team_refund_watch_register ON team_refund_watch(merchant_id,register_scope,seen_at);
      CREATE INDEX IF NOT EXISTS team_request_events_by_id ON team_refund_request_events(merchant_id, request_id, sequence);
      CREATE TABLE IF NOT EXISTS team_square_attempts (
        merchant_id TEXT NOT NULL, request_id TEXT NOT NULL, terms TEXT NOT NULL, started_at TEXT NOT NULL,
        PRIMARY KEY (merchant_id, request_id),
        FOREIGN KEY (merchant_id, request_id) REFERENCES team_refund_requests(merchant_id, id)
      );
      CREATE TABLE IF NOT EXISTS team_paypal_attempts (
        merchant_id TEXT NOT NULL, request_id TEXT NOT NULL, terms TEXT NOT NULL, started_at TEXT NOT NULL,
        PRIMARY KEY (merchant_id, request_id),
        FOREIGN KEY (merchant_id, request_id) REFERENCES team_refund_requests(merchant_id, id)
      );
    `);
  }

  private select() {
    return `SELECT r.id,r.terms,r.sale,r.created_at AS createdAt,
      (SELECT json_group_array(json(e.payload)) FROM (
        SELECT payload FROM team_refund_request_events WHERE merchant_id=r.merchant_id AND request_id=r.id ORDER BY sequence
      ) e) AS events FROM team_refund_requests r`;
  }
  list(employee: Employee) {
    return (this.db.prepare(this.select()+" WHERE r.merchant_id=? ORDER BY r.created_at DESC,r.id")
      .all(employee.merchantId) as unknown as RequestRow[]).map(project);
  }
  listForSale(employee: Employee, reference: string) {
    return (this.db.prepare(this.select() + " WHERE r.merchant_id=? AND json_extract(r.terms,'$.reference')=? ORDER BY r.created_at DESC,r.id")
      .all(employee.merchantId, reference) as unknown as RequestRow[]).map(project);
  }
  open(employee: Employee, id: string) {
    const row = this.db.prepare(this.select()+" WHERE r.merchant_id=? AND r.id=?").get(employee.merchantId,id) as RequestRow | undefined;
    if (!row) throw new TeamError("TRANSACTION_NOT_FOUND",404);
    const request = project(row);
    const monitoring = checks(request).monitoring;
    if (!canReview(employee.role) || !monitoring ||
      Math.max(monitoring.cashierWatchCount, monitoring.registerWatchCount) < repeatWatchThreshold) return request;

    const ids = [...monitoring.related, id];
    const rows = this.db.prepare(`SELECT w.request_id AS id, w.cashier, w.register_scope AS scope, w.seen_at AS occurredAt,
      json_extract(r.terms,'$.amount') AS amount, json_extract(r.sale,'$.location') AS location,
      json_extract(r.sale,'$.register') AS register,
      (SELECT json_extract(e.payload,'$.actor') FROM team_refund_request_events e
        WHERE e.merchant_id=w.merchant_id AND e.request_id=w.request_id
        AND json_extract(e.payload,'$.kind')='Request submitted' ORDER BY e.sequence LIMIT 1) AS actor
      FROM team_refund_watch w JOIN team_refund_requests r ON r.merchant_id=w.merchant_id AND r.id=w.request_id
      WHERE w.merchant_id=? AND w.request_id IN (${ids.map(() => "?").join(",")})
      ORDER BY w.seen_at,w.request_id`).all(employee.merchantId, ...ids) as unknown as
      Array<RefundWatchEntry & { cashier: string; scope: string }>;
    const current = rows.find(entry => entry.id === id);
    if (!current) return request;
    const entry = ({ id, actor, occurredAt, amount, location, register }: RefundWatchEntry): RefundWatchEntry =>
      ({ id, actor, occurredAt, amount, location, register });
    return { ...request, watchActivity: {
      cashier: rows.filter(row => row.cashier === current.cashier).map(entry),
      register: rows.filter(row => current.scope && row.scope === current.scope).map(entry),
    }};
  }

  policy(employee: Employee) {
    const row=this.db.prepare("SELECT threshold_cents AS threshold FROM team_refund_policy WHERE merchant_id=?").get(employee.merchantId);
    return { thresholdCents: typeof row?.threshold === "number" ? row.threshold : 5000 };
  }
  previewThreshold(employee: Employee, { location, shift, week, thresholdCents }: RefundPreviewScope) {
    const currentCents = this.policy(employee).thresholdCents;
    const scope = this.select() + " WHERE r.merchant_id=? AND COALESCE(json_extract(r.sale,'$.location'),'Unavailable')=?";
    if (week === undefined) {
      const rows = this.db.prepare(scope + " AND COALESCE(json_extract(r.sale,'$.shift'),'Unavailable')=? ORDER BY r.created_at DESC,r.id")
        .all(employee.merchantId, location, shift!) as unknown as RequestRow[];
      return previewRefundThreshold(rows.map(project), currentCents, thresholdCents);
    }

    const currentWeekStart = cashWeekMonday(cashStoreDate(this.now()));
    if (week >= currentWeekStart) throw new TeamError("REFUND_PREVIEW_WEEK_OPEN", 422);
    const start = cashWeekMonday(week);
    const next = addCashWeekDays(start, 7);
    // Narrow the UTC query, then apply the reporting calendar at the store's local midnight.
    const rows = this.db.prepare(scope + " AND r.created_at>=? AND r.created_at<? ORDER BY r.created_at DESC,r.id")
      .all(employee.merchantId, location, start, addCashWeekDays(next, 1)) as unknown as (RequestRow & { createdAt: string })[];
    const requests = rows.filter(row => {
      const day = cashStoreDate(row.createdAt);
      return day >= start && day < next;
    }).map(project);
    return { ...previewRefundThreshold(requests, currentCents, thresholdCents),
      period: { start, end: addCashWeekDays(start, 6), timeZone: cashTimeZone } };
  }
  policyHistory(employee: Employee): RefundPolicyHistory {
    if (employee.role !== "owner") throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    const changes = this.db.prepare(`SELECT preview_id AS id, location, actor, effective_at AS effectiveAt,
      old_cents AS oldCents, new_cents AS newCents FROM team_refund_policy_changes WHERE merchant_id=? ORDER BY sequence DESC`)
      .all(employee.merchantId) as unknown as RefundPolicyHistory["changes"];
    return { ...this.policy(employee), changes };
  }

  private policyRevision(merchantId: string) {
    return Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM team_refund_policy_changes WHERE merchant_id=?")
      .get(merchantId)?.revision);
  }

  previewPolicyChange(employee: Employee, scope: RefundPreviewScope): ThresholdPreview {
    if (employee.role !== "owner") throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    const preview = this.previewThreshold(employee, scope);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO team_refund_policy_previews VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant_id, username) DO UPDATE SET id=excluded.id, location=excluded.location,
      revision=excluded.revision, old_cents=excluded.old_cents, new_cents=excluded.new_cents`)
      .run(employee.merchantId, employee.username, id, scope.location, this.policyRevision(employee.merchantId),
        preview.currentCents, preview.proposedCents);
    return { ...preview, changePreviewId: id };
  }

  setPolicy(employee: Employee, previewId: string) {
    if (employee.role !== "owner") throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    const { merchantId, username, name } = employee;
    const committed = this.db.prepare("SELECT 1 FROM team_refund_policy_changes WHERE merchant_id=? AND username=? AND preview_id=?")
      .get(merchantId, username, previewId);
    if (committed) return this.policyHistory(employee);
    const preview = this.db.prepare(`SELECT location, revision, old_cents AS oldCents, new_cents AS newCents
      FROM team_refund_policy_previews WHERE merchant_id=? AND username=? AND id=?`)
      .get(merchantId, username, previewId) as { location: string; revision: number; oldCents: number; newCents: number } | undefined;
    if (!preview || preview.revision !== this.policyRevision(merchantId) || preview.oldCents !== this.policy(employee).thresholdCents) {
      throw new TeamError("REFUND_POLICY_PREVIEW_STALE", 409);
    }
    if (preview.oldCents === preview.newCents) return this.policyHistory(employee);
    this.db.prepare(`INSERT INTO team_refund_policy VALUES (?,?) ON CONFLICT(merchant_id)
      DO UPDATE SET threshold_cents=excluded.threshold_cents`).run(merchantId, preview.newCents);
    this.db.prepare(`INSERT INTO team_refund_policy_changes
      (merchant_id, preview_id, username, actor, location, effective_at, old_cents, new_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(merchantId, previewId, username, name, preview.location, this.now(), preview.oldCents, preview.newCents);
    this.db.prepare("DELETE FROM team_refund_policy_previews WHERE merchant_id=? AND username=?").run(merchantId, username);
    return this.policyHistory(employee);
  }
  private saleUsage(employee: Employee, sale: TestSale, countedRefunds: ProviderRefundEvidence[] = [], excludeId?: string) {
    let paidCents=0, reservedCents=0;
    const provider = saleProvider(sale);
    const rows = this.listForSale(employee, sale.reference);
    for (const request of rows) {
      if (request.id === excludeId || !request.sale || saleProvider(request.sale) !== provider ||
          request.sale.square?.merchantId !== sale.square?.merchantId || request.sale.square?.locationId !== sale.square?.locationId ||
          request.sale.paypal?.merchantId !== sale.paypal?.merchantId || request.sale.paypal?.orderId !== sale.paypal?.orderId ||
          checks(request).route === "over-balance" || executionStopped(request) || requestDecision(request)?.decision === "Rejected") continue;
      if (provider) {
        const verification = providerVerification(request);
        const responseId = providerResponse(request)?.refund.id;
        const counted = countedRefunds.find(refund => refund.id === responseId);
        if (verification?.result === "Failed" || (counted &&
          counted.paymentId === sale.reference && counted.locationId === sale.square?.locationId &&
          counted.currency === request.terms.currency && counted.amountCents === cents(request.terms.amount))) continue;
      }
      if (payout(request)) paidCents+=cents(request.terms.amount); else reservedCents+=cents(request.terms.amount);
    }
    return { paidCents, reservedCents, balanceCents:sale.originalCents-sale.priorCents-paidCents-reservedCents };
  }
  lookup(employee: Employee, reference: string, evidence?: ElectronicSaleEvidence) {
    const sale=evidence?.sale ?? testSale(reference);
    return sale ? {sale,...this.saleUsage(employee,sale,evidence?.countedRefunds)} : null;
  }
  replay(employee: Employee, submissionId: string, terms: RefundTerms) {
    const existing = this.db.prepare("SELECT id,terms FROM team_refund_requests WHERE merchant_id=? AND submission_id=?")
      .get(employee.merchantId,submissionId);
    if (typeof existing?.id === "string") {
      if (existing.terms !== JSON.stringify(terms)) throw new TeamError("TRANSACTION_SUBMISSION_CHANGED",409);
      return this.open(employee,existing.id);
    }
  }
  create(employee: Employee, submissionId: string, terms: RefundTerms, alerts:RefundAlertStore, evidence?: ElectronicSaleEvidence,
    demo?: { sale: TestSale; occurredAt: string; escalationMs: number }) {
    const existing = this.replay(employee, submissionId, terms);
    if (existing) return existing;
    if (terms.source === "square" && !evidence) throw new TeamError("SQUARE_SALE_UNAVAILABLE",422);
    if (terms.source === "paypal" && !evidence) throw new TeamError("PAYPAL_CAPTURE_UNAVAILABLE",422);
    const payload = JSON.stringify(terms);
    const id=randomUUID(), occurredAt=demo?.occurredAt ?? this.now(), sale=demo?.sale ?? evidence?.sale ?? testSale(terms.reference);
    const { thresholdCents }=this.policy(employee);
    let check: RefundCheck;
    const amount=cents(terms.amount);
    const registerScope=sale && sale.register !== "Unavailable" ? JSON.stringify([sale.location,sale.register]) : "";
    // This baseline is explicitly synthetic. Real cohorts need comparable POS history.
    const size=assessSize(amount,sale ? { median:1800,mad:500,floor:500 } : undefined);
    const cutoff=new Date(Date.parse(occurredAt)-watchWindowMs).toISOString();
    const recent=size.watch ? (this.db.prepare(`SELECT request_id AS id,cashier,register_scope AS scope
      FROM team_refund_watch w WHERE merchant_id=? AND seen_at>? AND seen_at<=? AND (cashier=? OR (?<>'' AND register_scope=?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM team_refund_requests r WHERE r.merchant_id=w.merchant_id AND r.id=w.request_id
        AND COALESCE(json_extract(r.sale,'$.shift')='Demo shift',0)=?))
      ORDER BY seen_at DESC,request_id`).all(employee.merchantId,cutoff,occurredAt,employee.username,registerScope,registerScope,
        this.demoWorkspace ? 1 : null,demo ? 1 : 0) as { id:string; cashier:string; scope:string }[]) : [];
    const cashierWatchCount=size.watch ? 1+recent.filter(row=>row.cashier===employee.username).length : 0;
    const registerWatchCount=size.watch && registerScope ? 1+recent.filter(row=>row.scope===registerScope).length : 0;
    const reasons:string[]=[];
    if (size.absoluteHold) reasons.push("The amount meets the "+money(individualLimitCents)+" individual limit.");
    if (size.relativeHold) reasons.push("The amount is unusually large for the test baseline (score "+size.z?.toFixed(2)+").");
    if (cashierWatchCount>=repeatWatchThreshold) reasons.push(cashierWatchCount+" unusual refunds by this cashier across registers in 15 minutes.");
    if (registerWatchCount>=repeatWatchThreshold) reasons.push(registerWatchCount+" unusual refunds at this register across cashiers in 15 minutes.");
    const monitoring={ruleVersion,z:size.z,watch:size.watch,cashierWatchCount,registerWatchCount,related:recent.slice(0,8).map(row=>row.id),reasons,drift:syntheticRegisterDrift(terms.reference)};
    if (!sale) {
      check={route:"exception",balanceCents:null,cumulativeCents:null,thresholdCents,monitoring,
        explanation:"The sale could not be verified. Route it to a manager for exception review. Payment remains blocked."};
    } else {
      const { balanceCents, reservedCents }=this.saleUsage(employee,sale,evidence?.countedRefunds);
      const cumulativeCents=sale.originalCents-balanceCents+amount;
      if(cumulativeCents>=thresholdCents) {
        const reason = thresholdReason(cumulativeCents, thresholdCents);
        if (sale.recordedDemo) reasons.unshift(reason); else reasons.push(reason);
      }
      const base={balanceCents,cumulativeCents,thresholdCents,monitoring,...(sale.recordedDemo&&{reservedCents})};
      check={...base,...routeVerifiedRefund(sale, amount, balanceCents, reasons)};
    }
    this.db.prepare("INSERT INTO team_refund_requests VALUES (?,?,?,?,?,?,?)")
      .run(employee.merchantId,id,submissionId,employee.username,payload,JSON.stringify(sale),occurredAt);
    if(size.watch) this.db.prepare("INSERT INTO team_refund_watch VALUES (?,?,?,?,?)")
      .run(employee.merchantId,id,employee.username,registerScope,occurredAt);
    this.add(employee,id,{kind:"Request submitted",actor:employee.name,occurredAt});
    this.add(employee,id,{kind:"Checks recorded",actor:"ChangeGate",occurredAt,check});
    alerts.queue(employee,id,sale?.location??"",check,occurredAt,demo?.escalationMs);
    return this.open(employee,id);
  }

  decide(employee: Employee, id: string, decision: RefundDecision, occurredAt = this.now()) {
    const request=this.open(employee,id);
    if (!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED",403);
    const requester=this.db.prepare("SELECT requester FROM team_refund_requests WHERE merchant_id=? AND id=?").get(employee.merchantId,id);
    if (requester?.requester===employee.username) throw new TeamError("TRANSACTION_SELF_REVIEW",403);
    const previous=requestDecision(request);
    if (previous?.decision===decision) return request;
    if (previous) throw new TeamError("TRANSACTION_DECIDED",409);
    const route=checks(request).route;
    if (route!=="manager"&&route!=="exception") throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE",409);
    this.add(employee,id,{kind:"Decision recorded",actor:employee.name,occurredAt,decision});
    return this.open(employee,id);
  }

  reportCash(employee: Employee,id: string) {
    const request=this.open(employee,id);
    if (payout(request)) return request;
    if (requestStatus(request)!=="Ready for cash payout") throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE",409);
    this.add(employee,id,{kind:"Cash payout reported",actor:employee.name,occurredAt:this.now()});
    return this.open(employee,id);
  }

  electronicExecution(employee: Employee, id: string) {
    const request = this.open(employee, id);
    const provider = saleProvider(request.sale);
    if (!provider || checks(request).route === "over-balance" ||
        ((provider === "square" || checks(request).route !== "routine") && requestDecision(request)?.decision !== "Approved")) {
      throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE", 409);
    }
    const table = provider === "square" ? "team_square_attempts" : "team_paypal_attempts";
    const row = this.db.prepare(`SELECT terms, started_at FROM ${table} WHERE merchant_id=? AND request_id=?`)
      .get(employee.merchantId, id);
    const attempt = typeof row?.terms === "string" && typeof row.started_at === "string" ?
      { terms: JSON.parse(row.terms) as ElectronicAttemptTerms, startedAt: row.started_at } : undefined;
    return { request, provider, table, attempt, response: providerResponse(request)?.refund };
  }

  startElectronic(employee: Employee, id: string, alerts: RefundAlertStore, evidence?: ElectronicSaleEvidence) {
    const state = this.electronicExecution(employee, id);
    if (state.attempt) return { ...state, attempt: state.attempt, started: false };
    if (executionStopped(state.request)) return { ...state, started: false };
    const { request, provider, table } = state;
    const amountCents = cents(request.terms.amount);
    const sale = request.sale!;
    if (!evidence || evidence.sale.reference !== sale.reference || saleProvider(evidence.sale) !== provider ||
        evidence.sale.square?.merchantId !== sale.square?.merchantId || evidence.sale.square?.locationId !== sale.square?.locationId ||
        evidence.sale.paypal?.merchantId !== sale.paypal?.merchantId || evidence.sale.paypal?.orderId !== sale.paypal?.orderId) {
      throw new TeamError(provider === "square" ? "SQUARE_SALE_UNAVAILABLE" : "PAYPAL_CAPTURE_UNAVAILABLE", 422);
    }
    const { balanceCents } = this.saleUsage(employee, evidence.sale, evidence.countedRefunds, id);
    if (amountCents > balanceCents) {
      this.stopElectronic(employee, id, "The refundable balance dropped below the approved amount.");
      return { ...state, started: false };
    }
    if (provider === "paypal" && this.holdForCurrentThreshold(employee, request, evidence.sale, balanceCents, alerts)) return { ...state, started: false };
    const scope = sale.square ?? sale.paypal!;
    const terms: ElectronicAttemptTerms = { ...scope, key: randomUUID(), paymentId: sale.reference, amountCents, currency: "USD" };
    const startedAt = this.now();
    this.db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(employee.merchantId,id,JSON.stringify(terms),startedAt);
    this.add(employee,id,{kind:`${providerName(provider)} attempt recorded`,actor:employee.name,occurredAt:startedAt});
    return { ...state, attempt: { terms, startedAt }, started: true };
  }

  stopElectronic(employee: Employee, id: string, reason: string, definitelyNoRefund = false) {
    const { request, attempt, response } = this.electronicExecution(employee, id);
    if ((!attempt || definitelyNoRefund) && !response && !executionStopped(request)) {
      this.add(employee,id,{kind:"Execution stopped",actor:"ChangeGate",occurredAt:this.now(),reason});
    }
    return this.open(employee,id);
  }

  private holdForCurrentThreshold(employee: Employee, request: RefundRequest, sale: TestSale,
    balanceCents: number, alerts: RefundAlertStore) {
    if (requestDecision(request)?.decision === "Approved") return false;
    const { thresholdCents } = this.policy(employee);
    const cumulativeCents = sale.originalCents - balanceCents + cents(request.terms.amount);
    if (cumulativeCents < thresholdCents) return false;
    const check: RefundCheck = { ...checks(request), route: "manager", balanceCents, cumulativeCents, thresholdCents,
      explanation: "Cumulative refunds would reach " + money(cumulativeCents) +
        ", meeting or exceeding the " + money(thresholdCents) + " store threshold." };
    const occurredAt = this.now();
    this.add(employee, request.id, { kind: "Checks recorded", actor: "ChangeGate", occurredAt, check });
    const owner = this.db.prepare("SELECT requester FROM team_refund_requests WHERE merchant_id=? AND id=?")
      .get(employee.merchantId, request.id);
    alerts.queue({ ...employee, username: String(owner?.requester) }, request.id, sale.location, check, occurredAt);
    return true;
  }

  recordProviderResponse(employee: Employee, id: string, refund: ProviderRefundResponse | null, recovered = false) {
    const { response, provider } = this.electronicExecution(employee, id);
    if (response) return response;
    const name = providerName(provider);
    this.add(employee,id,refund ? {kind:recovered ? "PayPal refund recovered" : `${name} refund response`,
      actor:recovered ? employee.name : name+" Sandbox",occurredAt:this.now(),refund} :
      {kind:`${name} response unavailable`,actor:"ChangeGate",occurredAt:this.now()});
    return refund;
  }

  recordProviderLookup(employee: Employee, id: string, refund: ProviderRefundEvidence | null) {
    const { request, attempt, response, provider } = this.electronicExecution(employee, id);
    const previous = providerVerification(request);
    if (!attempt || executionStopped(request) || previous?.result === "Verified" || previous?.result === "Failed") return request;
    const { terms } = attempt;
    let result: RefundVerification;
    if (!refund) result = "Unconfirmed";
    else if (refund.id !== response?.id || refund.paymentId !== terms.paymentId || refund.locationId !== terms.locationId ||
        refund.amountCents !== terms.amountCents || refund.currency !== terms.currency) result = "Mismatch";
    else if (refund.status === "COMPLETED") result = "Verified";
    else if (refund.status === "PENDING") result = "Pending";
    else result = "Failed";
    this.add(employee,id,{kind:`${providerName(provider)} independent lookup`,actor:employee.name,occurredAt:this.now(),refund,result});
    return this.open(employee,id);
  }

  private add(employee: Employee, id: string, event: TransactionEvent) {
    this.db.prepare("INSERT INTO team_refund_request_events (merchant_id,request_id,username,payload) VALUES (?,?,?,?)")
      .run(employee.merchantId,id,employee.username,JSON.stringify(event));
  }
}
