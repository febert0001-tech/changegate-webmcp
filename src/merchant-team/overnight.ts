import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import type { CashDrawers } from "./cash-drawers";
import { CoverageGrants } from "./coverage-grants";
import { coverageTimeZone } from "./coverage-time";
import { demoLocations, demoMerchant } from "./demo-shift";
import { TeamError } from "./error";
import { canReview } from "./refund-requests";

export const overnightAccounts = [
  { username: "ivy-night", name: "Ivy Brooks" },
  { username: "noah-night", name: "Noah Reed" },
  { username: "sam-night", name: "Sam Ellis" },
] as const;

type Stamp = { actor: string; at: string };
type Handoff = Stamp & { requestId: string; checked: string; question: string; reply?: Stamp & { text: string } };
type Progress = { claimant: Stamp & { username: string }; handoff?: Handoff };
type CaseRow = { id: string; location: string; drawerId: string; reason: string; openedAt: string; progress: string | null };

export class OvernightDesk {
  private readonly grants: CoverageGrants;
  constructor(private readonly db: DatabaseSync, private readonly drawers: CashDrawers, private readonly now: () => string) {
    this.grants = new CoverageGrants(db, now);
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_overnight_cases (
        merchant_id TEXT NOT NULL, case_id TEXT NOT NULL, progress TEXT NOT NULL,
        PRIMARY KEY (merchant_id, case_id),
        FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
      );
    `);
  }

  private requireOwner(employee: Employee) {
    if (employee.merchantId !== demoMerchant || !canReview(employee.role)) throw new TeamError("COVERAGE_DENIED", 403);
  }

  private reviewerLocations(employee: Employee) {
    if (employee.role !== "reviewer" || employee.merchantId !== demoMerchant) throw new TeamError("COVERAGE_DENIED", 403);
    const locations = this.grants.activeLocations(employee.merchantId, employee.username);
    if (!locations.length) throw new TeamError("COVERAGE_EXPIRED", 403);
    return locations;
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
    const row = this.reviewerLocations(employee).flatMap(location => this.rows(employee, location)).find(row => row.id === id);
    if (!row) throw new TeamError("CASE_NOT_FOUND", 404);
    const evidence = this.drawers.coverageEvidence(employee, row.drawerId);
    const item = this.summary(row, evidence.report.variance);
    const claimant = item.progress?.claimant.username;
    const canClaim = claimant !== employee.username && (!claimant ||
      !this.grants.activeLocations(employee.merchantId, claimant).includes(row.location));
    return { ...item, evidence, canClaim };
  }

  desk(employee: Employee, id?: string): {
    cases: ReturnType<OvernightDesk["summary"]>[];
    detail: ReturnType<OvernightDesk["caseEvidence"]> | null;
  } {
    if (id) return { cases: [], detail: this.caseEvidence(employee, id) };
    const rows = this.reviewerLocations(employee).flatMap(location => this.rows(employee, location));
    return { cases: rows.map(row => this.queueItem(employee, row)), detail: null };
  }

  owner(employee: Employee) {
    this.requireOwner(employee);
    const cases = demoLocations.flatMap(location => this.rows(employee, location)).filter(row => row.progress)
      .map(row => this.queueItem(employee, row)).filter(row => row.progress?.handoff);
    return { cases };
  }

  settings(employee: Employee, roster: readonly Employee[]) {
    this.requireOwner(employee);
    return { locations: demoLocations, timeZone: coverageTimeZone, grants: this.grants.list(employee),
      reviewers: roster.filter(member => member.role === "reviewer" && member.merchantId === employee.merchantId)
        .map(({ username, name }) => ({ username, name })) };
  }

  grant(employee: Employee, roster: readonly Employee[], id: string, location: string, username: string,
    schedule?: { start: string; end: string }) {
    this.requireOwner(employee);
    const reviewer = roster.find(member => member.username === username && member.role === "reviewer" &&
      member.merchantId === employee.merchantId);
    if (!reviewer) throw new TeamError("COVERAGE_DENIED", 403);
    this.grants.grant(employee, reviewer, id, location, schedule);
    return this.settings(employee, roster);
  }

  revoke(employee: Employee, roster: readonly Employee[], id: string) {
    this.requireOwner(employee);
    this.grants.revoke(employee, id);
    return this.settings(employee, roster);
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
    const previous = item.progress?.claimant.username;
    if (previous === employee.username) return item;
    if (!item.canClaim) {
      throw new TeamError("COVERAGE_ALREADY_CLAIMED", 409);
    }
    const at = this.now();
    const claimant = { username: employee.username, actor: employee.name, at };
    const progress = { ...item.progress, claimant };
    this.save(employee, id, progress, "Coverage claimed", "Claimed for overnight drawer review.", at);
    return { ...item, progress, canClaim: false };
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
export type CoverageSettingsView = ReturnType<OvernightDesk["settings"]>;
export type OvernightOwner = ReturnType<OvernightDesk["owner"]>;

