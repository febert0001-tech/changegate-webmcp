import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { TeamError } from "./error";
import type { AlertEnrollment } from "./refund-alerts";
import { unavailableSaleLocation, type RefundCheck } from "./refund-requests";

export type AlertJob={merchantId:string; requestId:string; requester:string; location:string; phase:number;
  route:string; alertEvidence:string; tries:number; createdAt:number};
export class RefundAlertStore {
  constructor(private readonly db:DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_refund_alert_devices (
        endpoint TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, username TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_refund_alert_jobs (
        merchant_id TEXT NOT NULL, request_id TEXT NOT NULL, requester TEXT NOT NULL, location TEXT NOT NULL,
        phase INTEGER NOT NULL, route TEXT NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL,
        due INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', ai_attempted INTEGER NOT NULL DEFAULT 0, advisory TEXT,
        PRIMARY KEY(merchant_id,request_id,phase),
        FOREIGN KEY(merchant_id,request_id) REFERENCES team_refund_requests(merchant_id,id)
      );
      CREATE TABLE IF NOT EXISTS team_refund_alert_sent (
        merchant_id TEXT NOT NULL, request_id TEXT NOT NULL, phase INTEGER NOT NULL, endpoint TEXT NOT NULL,
        PRIMARY KEY(merchant_id,request_id,phase,endpoint)
      );
      CREATE INDEX IF NOT EXISTS team_refund_alert_due ON team_refund_alert_jobs(status,due,lease);
    `);
  }
  enroll(employee:Employee, model:AlertEnrollment) {
    const changes=this.db.prepare(`INSERT INTO team_refund_alert_devices VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at
      WHERE merchant_id=excluded.merchant_id AND username=excluded.username`)
      .run(model.endpoint,employee.merchantId,employee.username,JSON.stringify(model),Date.now()+12*60*60_000).changes;
    if (!changes) throw new TeamError("ALERT_DEVICE_IN_USE",409);
  }
  remove(employee:Employee,endpoint:string) {
    this.db.prepare("DELETE FROM team_refund_alert_devices WHERE merchant_id=? AND username=? AND endpoint=?")
      .run(employee.merchantId,employee.username,endpoint);
  }
  queue(employee:Employee,requestId:string,location:string,check:RefundCheck,occurredAt:string) {
    if(check.route==="routine") return;
    const now=Date.parse(occurredAt);
    const configured=Number(process.env.CHANGEGATE_ALERT_ESCALATION_SECONDS);
    const seconds=Number.isSafeInteger(configured)&&configured>=10&&configured<=1800?configured:120;
    const make=this.db.prepare(`INSERT INTO team_refund_alert_jobs
      (merchant_id,request_id,requester,location,phase,route,evidence,created_at,due) VALUES(?,?,?,?,?,?,?,?,?)`);
    // Only bounded numeric and server-generated rule evidence leaves the approval path.
    const evidence=JSON.stringify({balanceCents:check.balanceCents,cumulativeCents:check.cumulativeCents,
      thresholdCents:check.thresholdCents,route:check.route,score:check.monitoring?.z??null,
      cashierWatchCount:check.monitoring?.cashierWatchCount??0,registerWatchCount:check.monitoring?.registerWatchCount??0});
    make.run(employee.merchantId,requestId,employee.username,location,0,check.route,evidence,now,now);
    if(check.route!=="over-balance")make.run(employee.merchantId,requestId,employee.username,location,1,check.route,evidence,now,now+seconds*1000);
  }
  claim(now:number) {
    return this.db.prepare(`UPDATE team_refund_alert_jobs SET lease=?, tries=tries+1
      WHERE rowid=(SELECT rowid FROM team_refund_alert_jobs WHERE status='pending' AND due<=? AND lease<=?
        ORDER BY due,rowid LIMIT 1)
      RETURNING merchant_id AS merchantId, request_id AS requestId, requester, location, phase, route,
        evidence AS alertEvidence, tries, created_at AS createdAt`).get(now+120_000,now,now) as AlertJob|undefined;
  }
  decided(job:AlertJob) {
    return Boolean(this.db.prepare(`SELECT 1 FROM team_refund_request_events WHERE merchant_id=? AND request_id=?
      AND json_extract(payload,'$.kind')='Decision recorded'`).get(job.merchantId,job.requestId));
  }
  recipients(job:AlertJob) {
    const rows=this.db.prepare(`SELECT d.username,d.payload FROM team_refund_alert_devices d
      WHERE d.merchant_id=? AND d.username<>? AND d.expires_at>? AND NOT EXISTS(
        SELECT 1 FROM team_refund_alert_sent s WHERE s.merchant_id=d.merchant_id AND s.endpoint=d.endpoint AND s.request_id=? AND s.phase=?
      ) ORDER BY d.endpoint`).all(job.merchantId,job.requester,Date.now(),job.requestId,job.phase) as {username:string;payload:string}[];
    const duty=job.phase===0?"primary":"backup";
    // Captures without a provider location still need review by the merchant on duty.
    const merchantWide=job.location===unavailableSaleLocation;
    return rows.map(row=>({username:row.username,subscription:JSON.parse(row.payload) as AlertEnrollment}))
      .filter(({subscription:s})=>s.duty===duty && (merchantWide || !s.location || s.location===job.location));
  }
  sent(job:AlertJob,endpoint:string) {
    this.db.prepare("INSERT OR IGNORE INTO team_refund_alert_sent VALUES(?,?,?,?)")
      .run(job.merchantId,job.requestId,job.phase,endpoint);
  }
  hasSent(job:AlertJob) {
    return Boolean(this.db.prepare("SELECT 1 FROM team_refund_alert_sent WHERE merchant_id=? AND request_id=? AND phase=? LIMIT 1")
      .get(job.merchantId,job.requestId,job.phase));
  }
  retired(job:AlertJob,endpoint:string) {
    this.db.prepare("DELETE FROM team_refund_alert_devices WHERE merchant_id=? AND endpoint=?").run(job.merchantId,endpoint);
  }
  markAi(job:AlertJob) {
    return Boolean(this.db.prepare(`UPDATE team_refund_alert_jobs SET ai_attempted=1
      WHERE merchant_id=? AND request_id=? AND phase=0 AND ai_attempted=0 RETURNING phase`).get(job.merchantId,job.requestId));
  }
  saveAdvisory(job:AlertJob,advisory:string) {
    this.db.prepare("UPDATE team_refund_alert_jobs SET advisory=? WHERE merchant_id=? AND request_id=? AND phase=0")
      .run(advisory,job.merchantId,job.requestId);
  }
  finish(job:AlertJob,status:string, due=0) {
    this.db.prepare(`UPDATE team_refund_alert_jobs SET status=?,due=?,lease=0
      WHERE merchant_id=? AND request_id=? AND phase=? AND tries=?`)
      .run(status,due,job.merchantId,job.requestId,job.phase,job.tries);
  }
  status(employee:Employee,id:string) {
    return this.db.prepare(`SELECT phase,status,advisory FROM team_refund_alert_jobs WHERE merchant_id=? AND request_id=? ORDER BY phase`)
      .all(employee.merchantId,id) as {phase:number;status:string;advisory:string|null}[];
  }
}
