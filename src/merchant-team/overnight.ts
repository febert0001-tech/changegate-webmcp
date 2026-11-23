import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import type { CashDrawers } from "./cash-drawers";
import { demoMerchant } from "./demo-shift";
import { TeamError } from "./error";
import { canReview } from "./refund-requests";

export const overnightAccounts = [
  { username: "ivy-night", name: "Ivy Brooks", location: "Harbor Fuel" },
  { username: "noah-night", name: "Noah Reed", location: "Harbor Fuel" },
  { username: "sam-night", name: "Sam Ellis", location: null },
] as const;

type Stamp = { actor: string; at: string };
type Handoff = Stamp & { requestId: string; checked: string; question: string; reply?: Stamp & { text: string } };
type Progress = { claimant: Stamp & { username: string }; handoff?: Handoff };
type CaseRow = { id: string; location: string; drawerId: string; reason: string; openedAt: string; progress: string | null };
const coverageLength = 8 * 60 * 60 * 1000;

export class OvernightDesk {
  constructor(private readonly db: DatabaseSync, private readonly drawers: CashDrawers, private readonly now: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_overnight_coverage (
        merchant_id TEXT PRIMARY KEY, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_overnight_cases (
        merchant_id TEXT NOT NULL, case_id TEXT NOT NULL, progress TEXT NOT NULL,
        PRIMARY KEY (merchant_id, case_id),
        FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
      );
    `);
  }

  private coverage(employee: Employee) {
    const row = this.db.prepare("SELECT expires_at AS until FROM team_overnight_coverage WHERE merchant_id=?")
      .get(employee.merchantId) as { until: string } | undefined;
    return row && row.until > this.now() ? row.until : null;
  }

  private requireOwner(employee: Employee) {
    if (employee.merchantId !== demoMerchant || !canReview(employee.role)) throw new TeamError("COVERAGE_DENIED", 403);
  }

  private reviewerLocation(employee: Employee) {
    const account = overnightAccounts.find(account => account.username === employee.username);
    if (employee.role !== "reviewer" || employee.merchantId !== demoMerchant || !account?.location) {
      throw new TeamError("COVERAGE_DENIED", 403);
    }
    if (!this.coverage(employee)) throw new TeamError("COVERAGE_EXPIRED", 403);
    return account.location;
  }

  private rows(employee: Employee, location: string) {
    return this.db.prepare(`
      SELECT c.id, d.location, d.id AS drawerId, c.finding AS reason,
        (SELECT MIN(h.occurred_at) FROM team_history h WHERE h.merchant_id=c.merchant_id AND h.case_id=c.id) AS openedAt,
        o.progress
      FROM team_cases c
      JOIN team_cash_drawers d ON d.merchant_id=c.merchant_id AND d.case_id=c.id
      LEFT JOIN team_overnight_cases o ON o.merchant_id=c.merchant_id AND o.case_id=c.id
      WHERE c.merchant_id=? AND d.location=? AND d.first_count IS NOT NULL AND c.status != 'Resolved'
      ORDER BY openedAt, c.id
    `).all(employee.merchantId, location) as unknown as CaseRow[];
  }

  private summary(row: CaseRow, variance: number) {
    const progress = row.progress ? JSON.parse(row.progress) as Progress : undefined;
    return { id: row.id, location: row.location, reason: row.reason, openedAt: row.openedAt, variance, progress };
  }

  private queueItem(employee: Employee, row: CaseRow) {
    return this.summary(row, this.drawers.coverageEvidence(employee, row.drawerId).report.variance);
  }

  private caseEvidence(employee: Employee, id: string) {
    const row = this.rows(employee, this.reviewerLocation(employee)).find(row => row.id === id);
    if (!row) throw new TeamError("CASE_NOT_FOUND", 404);
    const evidence = this.drawers.coverageEvidence(employee, row.drawerId);
    return { ...this.summary(row, evidence.report.variance), evidence };
  }

  desk(employee: Employee, id?: string): {
    cases: ReturnType<OvernightDesk["summary"]>[];
    detail: ReturnType<OvernightDesk["caseEvidence"]> | null;
  } {
    if (id) return { cases: [], detail: this.caseEvidence(employee, id) };
    const location = this.reviewerLocation(employee);
    return { cases: this.rows(employee, location).map(row => this.queueItem(employee, row)), detail: null };
  }

  owner(employee: Employee) {
    this.requireOwner(employee);
    const cases = this.rows(employee, "Harbor Fuel").filter(row => row.progress)
      .map(row => this.queueItem(employee, row)).filter(row => row.progress?.handoff);
    return { until: this.coverage(employee), cases };
  }

  setCoverage(employee: Employee, active: boolean) {
    this.requireOwner(employee);
    const now = this.now();
    this.db.prepare(`INSERT INTO team_overnight_coverage VALUES (?, ?)
      ON CONFLICT(merchant_id) DO UPDATE SET expires_at=excluded.expires_at`)
      .run(employee.merchantId, active ? new Date(Date.parse(now) + coverageLength).toISOString() : now);
    return this.owner(employee);
  }

  private save(employee: Employee, id: string, progress: Progress, kind: string, detail: string, at: string) {
    this.db.prepare(`INSERT INTO team_overnight_cases VALUES (?, ?, ?)
      ON CONFLICT(merchant_id, case_id) DO UPDATE SET progress=excluded.progress`)
      .run(employee.merchantId, id, JSON.stringify(progress));
    this.db.prepare(`INSERT INTO team_history(merchant_id, case_id, actor, username, kind, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(employee.merchantId, id, employee.name, employee.username, kind, detail, at);
  }

  claim(employee: Employee, id: string) {
    const item = this.caseEvidence(employee, id);
    if (item.progress) {
      if (item.progress.claimant.username !== employee.username) throw new TeamError("COVERAGE_ALREADY_CLAIMED", 409);
      return item;
    }
    const at = this.now();
    const claimant = { username: employee.username, actor: employee.name, at };
    this.save(employee, id, { claimant }, "Coverage claimed", "Claimed for overnight drawer review.", at);
    return { ...item, progress: { claimant } };
  }

  handoff(employee: Employee, id: string, requestId: string, checked: string, question: string) {
    const item = this.caseEvidence(employee, id);
    const progress = item.progress;
    if (progress?.claimant.username !== employee.username) throw new TeamError("COVERAGE_CLAIM_REQUIRED", 403);
    if (progress.handoff?.requestId === requestId) return item;
    if (progress.handoff && !progress.handoff.reply) throw new TeamError("COVERAGE_REPLY_PENDING", 409);
    const at = this.now();
    const next = { ...progress, handoff: { requestId, checked, question, actor: employee.name, at } };
    this.save(employee, id, next, "Owner follow-up requested", `Checked: ${checked}\nQuestion: ${question}`, at);
    return { ...item, progress: next };
  }

  reply(employee: Employee, id: string, requestId: string, text: string) {
    this.requireOwner(employee);
    const item = this.owner(employee).cases.find(item => item.id === id);
    const progress = item?.progress;
    const handoff = progress?.handoff;
    if (!handoff || handoff.requestId !== requestId) throw new TeamError("CASE_NOT_FOUND", 404);
    if (handoff.reply) {
      if (handoff.reply.text === text) return this.owner(employee);
      throw new TeamError("COVERAGE_ALREADY_ANSWERED", 409);
    }
    const at = this.now();
    this.save(employee, id, { ...progress, handoff: { ...handoff, reply: { actor: employee.name, at, text } } },
      "Owner replied", text, at);
    return this.owner(employee);
  }
}

export type OvernightQueue = ReturnType<OvernightDesk["desk"]>;
export type OvernightOwner = ReturnType<OvernightDesk["owner"]>;

