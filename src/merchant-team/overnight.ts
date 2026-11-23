import type { DatabaseSync } from "node:sqlite";
import type { CaseHistory, Employee, HistoryKind } from "./contracts";
import type { CashDrawers } from "./cash-drawers";
import { CoverageGrants } from "./coverage-grants";
import { coverageTimeZone, type CoverageGrant } from "./coverage-time";
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
type Claimant = Stamp & { username: string; grantId?: string };
type ShiftEnd = { reviewer: Claimant; at: string; reason: string };
type Progress = { claimant?: Claimant; shiftEnd?: ShiftEnd; handoff?: Handoff };
type CaseRow = { id: string; location: string; drawerId: string; reason: string; openedAt: string; progress: string | null };

const grantEnds = (grant: CoverageGrant) => grant.revokedAt ?? grant.endsAt;
const includesTime = (grant: CoverageGrant, at: string) =>
  grant.grantedAt <= at && grant.startsAt <= at && grantEnds(grant) > at;
const awaitingReply = (progress?: Progress) => Boolean(progress?.handoff && !progress.handoff.reply);

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

  private rows(merchantId: string, location: string) {
    return this.db.prepare(`
      SELECT c.id, d.location, d.id AS drawerId, c.finding AS reason,
        (SELECT MIN(h.occurred_at) FROM team_history h WHERE h.merchant_id=c.merchant_id AND h.case_id=c.id) AS openedAt,
        o.progress
      FROM team_cases c
      JOIN team_cash_drawers d ON d.merchant_id=c.merchant_id AND d.case_id=c.id
      LEFT JOIN team_overnight_cases o ON o.merchant_id=c.merchant_id AND o.case_id=c.id
      WHERE c.merchant_id=? AND d.location=? AND d.first_count IS NOT NULL AND c.status != 'Resolved'
      ORDER BY openedAt, c.id
    `).all(merchantId, location) as unknown as CaseRow[];
  }

  private summary(row: CaseRow, variance: number) {
    const progress = row.progress ? JSON.parse(row.progress) as Progress : undefined;
    const responsible = awaitingReply(progress) || progress?.shiftEnd ? "Store owner"
      : progress?.claimant?.actor ?? "Available to claim";
    return { id: row.id, location: row.location, reason: row.reason, openedAt: row.openedAt, variance, progress, responsible };
  }

  private queueItem(employee: Employee, row: CaseRow) {
    return this.summary(row, this.drawers.coverageEvidence(employee, row.drawerId).report.variance);
  }

  private caseEvidence(employee: Employee, id: string) {
    const row = this.reviewerLocations(employee).flatMap(location => this.rows(employee.merchantId, location)).find(row => row.id === id);
    if (!row) throw new TeamError("CASE_NOT_FOUND", 404);
    const evidence = this.drawers.coverageEvidence(employee, row.drawerId);
    const item = this.summary(row, evidence.report.variance);
    return { ...item, evidence, canClaim: !item.progress };
  }

  desk(employee: Employee, id?: string): {
    cases: ReturnType<OvernightDesk["summary"]>[];
    detail: ReturnType<OvernightDesk["caseEvidence"]> | null;
  } {
    if (id) return { cases: [], detail: this.caseEvidence(employee, id) };
    const rows = this.reviewerLocations(employee).flatMap(location => this.rows(employee.merchantId, location));
    return { cases: rows.map(row => this.queueItem(employee, row)), detail: null };
  }

  settle(merchantId: string) {
    if (merchantId !== demoMerchant) return;
    const now = this.now();
    const grants = this.grants.list(merchantId);
    const rows = demoLocations.flatMap(location => this.rows(merchantId, location));
    for (const row of rows) {
      if (!row.progress) continue;
      const progress = JSON.parse(row.progress) as Progress;
      const reviewer = progress.claimant;
      if (!reviewer) continue;
      const grant = grants.find(grant => grant.location === row.location && grant.reviewer === reviewer.username &&
        (reviewer.grantId ? reviewer.grantId === grant.id : includesTime(grant, reviewer.at)));
      if (grant && grantEnds(grant) > now) {
        if (!reviewer.grantId) this.writeProgress(merchantId, row.id, { ...progress, claimant: { ...reviewer, grantId: grant.id } });
        continue;
      }
      const at = grant ? grantEnds(grant) : now;
      const reason = grant ? (grant.revokedBy ? "Coverage revoked by " + grant.revokedBy : "Scheduled coverage ended")
        : "Original claim predates recorded coverage";
      const waiting = awaitingReply(progress);
      const next: Progress = { ...(progress.handoff && { handoff: progress.handoff }), shiftEnd: { reviewer, at, reason } };
      this.save({ merchantId, name: "ChangeGate", username: "changegate" },
        row.id, next, "Reviewer shift ended", `${reviewer.actor} · ${reason}. ${waiting
          ? "Owner reply remains next." : "Returned to store owner for reassignment."}`, at);
    }
  }

  private reviewers(employee: Employee, roster: readonly Employee[]) {
    return roster.filter(member => member.role === "reviewer" && member.merchantId === employee.merchantId)
      .map(({ username, name }) => ({ username, name }));
  }

  owner(employee: Employee, roster: readonly Employee[]) {
    this.requireOwner(employee);
    const reviewers = this.reviewers(employee, roster);
    const grants = this.grants.list(employee.merchantId);
    const cases = demoLocations.flatMap(location => this.rows(employee.merchantId, location)).filter(row => row.progress)
      .map(row => {
        const item = this.queueItem(employee, row);
        const lastAction = this.db.prepare(`
          SELECT kind, actor, occurred_at AS occurredAt FROM team_history
          WHERE merchant_id=? AND case_id=? AND kind!='Reviewer shift ended' ORDER BY sequence DESC LIMIT 1
        `).get(employee.merchantId, row.id) as Pick<CaseHistory, "kind" | "actor" | "occurredAt"> | undefined;
        const eligible = item.progress?.shiftEnd && !awaitingReply(item.progress) ? reviewers.filter(reviewer =>
          reviewer.username !== item.progress?.shiftEnd?.reviewer.username && grants.some(grant =>
            grant.status === "Active" && grant.location === row.location && grant.reviewer === reviewer.username)) : [];
        return { ...item, lastAction, eligible };
      });
    return { cases };
  }

  settings(employee: Employee, roster: readonly Employee[]) {
    this.requireOwner(employee);
    return { locations: demoLocations, timeZone: coverageTimeZone, grants: this.grants.list(employee.merchantId),
      reviewers: this.reviewers(employee, roster) };
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
    this.settle(employee.merchantId);
    return this.settings(employee, roster);
  }

  private writeProgress(merchantId: string, id: string, progress: Progress) {
    this.db.prepare(`INSERT INTO team_overnight_cases VALUES (?, ?, ?)
      ON CONFLICT(merchant_id, case_id) DO UPDATE SET progress=excluded.progress`)
      .run(merchantId, id, JSON.stringify(progress));
  }

  private save(employee: Pick<Employee, "merchantId" | "name" | "username">, id: string, progress: Progress, kind: HistoryKind, detail: string, at: string) {
    this.writeProgress(employee.merchantId, id, progress);
    this.db.prepare(`INSERT INTO team_history(merchant_id, case_id, actor, username, kind, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(employee.merchantId, id, employee.name, employee.username, kind, detail, at);
  }

  claim(employee: Employee, id: string) {
    const item = this.caseEvidence(employee, id);
    const previous = item.progress?.claimant?.username;
    if (previous === employee.username) return item;
    if (!item.canClaim) {
      throw new TeamError("COVERAGE_ALREADY_CLAIMED", 409);
    }
    const claimant = this.assignee(employee.merchantId, item.location, employee.username, employee.name);
    const progress = { claimant };
    this.save(employee, id, progress, "Coverage claimed", "Claimed for overnight drawer review.", claimant.at);
    return this.caseEvidence(employee, id);
  }

  private assignee(merchantId: string, location: string, username: string, actor: string): Claimant {
    const at = this.now();
    const grant = this.grants.list(merchantId).find(grant => grant.reviewer === username && grant.location === location &&
      includesTime(grant, at));
    if (!grant) throw new TeamError("COVERAGE_EXPIRED", 403);
    return { username, actor, at, grantId: grant.id };
  }

  reassign(employee: Employee, roster: readonly Employee[], id: string, username: string, endedAt: string) {
    const item = this.owner(employee, roster).cases.find(item => item.id === id);
    if (!item) throw new TeamError("CASE_NOT_FOUND", 404);
    const current = item.progress?.shiftEnd;
    if (!current || current.at !== endedAt || awaitingReply(item.progress)) throw new TeamError("COVERAGE_CASE_CHANGED", 409);
    const reviewer = item.eligible.find(member => member.username === username);
    if (!reviewer) throw new TeamError("COVERAGE_REASSIGN_UNAVAILABLE", 409);
    const claimant = this.assignee(employee.merchantId, item.location, reviewer.username, reviewer.name);
    const handoff = item.progress?.handoff;
    this.save(employee, id, { claimant, ...(handoff && { handoff }) }, "Coverage reassigned",
      `${current.reviewer.actor} → ${claimant.actor}. ${current.reason} at ${current.at}.`, claimant.at);
    return this.owner(employee, roster);
  }

  handoff(employee: Employee, id: string, grantId: string, requestId: string, checked: string, question: string) {
    const item = this.caseEvidence(employee, id);
    const progress = item.progress;
    if (progress?.claimant?.username !== employee.username) throw new TeamError("COVERAGE_CLAIM_REQUIRED", 403);
    const current = this.assignee(employee.merchantId, item.location, employee.username, employee.name);
    if (current.grantId !== grantId || (progress.claimant.grantId && progress.claimant.grantId !== grantId)) {
      throw new TeamError("COVERAGE_EXPIRED", 403);
    }
    if (progress.handoff?.requestId === requestId) return item;
    if (progress.handoff && !progress.handoff.reply) throw new TeamError("COVERAGE_REPLY_PENDING", 409);
    const at = this.now();
    const next = { ...progress, handoff: { requestId, checked, question, actor: employee.name, at } };
    this.save(employee, id, next, "Owner follow-up requested", `Checked: ${checked}\nQuestion: ${question}`, at);
    return this.caseEvidence(employee, id);
  }

  reply(employee: Employee, roster: readonly Employee[], id: string, requestId: string, text: string) {
    this.requireOwner(employee);
    const item = this.owner(employee, roster).cases.find(item => item.id === id);
    const progress = item?.progress;
    const handoff = progress?.handoff;
    if (!handoff || handoff.requestId !== requestId) throw new TeamError("CASE_NOT_FOUND", 404);
    if (handoff.reply) {
      if (handoff.reply.text === text) return this.owner(employee, roster);
      throw new TeamError("COVERAGE_ALREADY_ANSWERED", 409);
    }
    const at = this.now();
    this.save(employee, id, { ...progress, handoff: { ...handoff, reply: { actor: employee.name, at, text } } },
      "Owner replied", text, at);
    return this.owner(employee, roster);
  }
}

export type OvernightQueue = ReturnType<OvernightDesk["desk"]>;
export type CoverageSettingsView = ReturnType<OvernightDesk["settings"]>;
export type OvernightOwner = ReturnType<OvernightDesk["owner"]>;

