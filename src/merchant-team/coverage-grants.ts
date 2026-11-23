import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { coverageInstant, type CoverageGrant } from "./coverage-time";
import { demoLocations } from "./demo-shift";
import { TeamError } from "./error";

type SavedGrant = Omit<CoverageGrant, "status">;
const demoDuration = 8 * 60 * 60 * 1000;
const columns = `id, location, reviewer, reviewer_name AS reviewerName, starts_at AS startsAt, ends_at AS endsAt,
  granted_by AS grantedBy, granted_at AS grantedAt, revoked_by AS revokedBy, revoked_at AS revokedAt`;

export class CoverageGrants {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {
    // The old merchant-wide simulation has no named grantor or store-scoped schedule.
    // Existing case history stays intact. Reviewers need a new grant to access it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_coverage_grants (
        merchant_id TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL, reviewer TEXT NOT NULL,
        reviewer_name TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
        granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT,
        PRIMARY KEY (merchant_id, id)
      );
      CREATE INDEX IF NOT EXISTS team_coverage_access
        ON team_coverage_grants(merchant_id, reviewer, location, ends_at);
    `);
  }

  activeLocations(merchant: string, reviewer: string) {
    const now = this.now();
    return this.db.prepare(`SELECT DISTINCT location FROM team_coverage_grants
      WHERE merchant_id=? AND reviewer=? AND revoked_at IS NULL AND granted_at<=? AND starts_at<=? AND ends_at>?`)
      .all(merchant, reviewer, now, now, now).map(row => row.location as string);
  }

  list(merchantId: string): CoverageGrant[] {
    const now = this.now();
    const rows = this.db.prepare(`SELECT ${columns} FROM team_coverage_grants
      WHERE merchant_id=? ORDER BY granted_at DESC, rowid DESC`).all(merchantId) as unknown as SavedGrant[];
    return rows.map(row => ({
      ...row, status: row.revokedAt ? "Revoked" : row.endsAt <= now ? "Ended" : row.startsAt > now ? "Scheduled" : "Active",
    }));
  }

  grant(employee: Employee, reviewer: Employee, id: string, location: string, schedule?: { start: string; end: string }) {
    if (!demoLocations.includes(location)) throw new TeamError("COVERAGE_DENIED", 403);
    const now = this.now();
    const start = schedule ? coverageInstant(schedule.start) : now;
    const end = schedule ? coverageInstant(schedule.end) : new Date(Date.parse(now) + demoDuration).toISOString();
    if (!start || !end || end <= start) throw new TeamError("COVERAGE_INVALID_WINDOW", 422);
    const prior = this.db.prepare(`SELECT ${columns} FROM team_coverage_grants WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as SavedGrant | undefined;
    if (prior) {
      if (prior.reviewer === reviewer.username && prior.location === location &&
        (!schedule || (start === prior.startsAt && end === prior.endsAt))) return;
      throw new TeamError("COVERAGE_GRANT_CONFLICT", 409);
    }
    if (end <= now) throw new TeamError("COVERAGE_INVALID_WINDOW", 422);
    const overlapping = this.db.prepare(`SELECT 1 FROM team_coverage_grants
      WHERE merchant_id=? AND reviewer=? AND location=? AND revoked_at IS NULL AND starts_at<? AND ends_at>?`)
      .get(employee.merchantId, reviewer.username, location, end, start < now ? now : start);
    if (overlapping) throw new TeamError("COVERAGE_GRANT_CONFLICT", 409);
    this.db.prepare("INSERT INTO team_coverage_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(employee.merchantId, id, location, reviewer.username, reviewer.name, start, end, employee.name, now);
  }

  revoke(employee: Employee, id: string) {
    const now = this.now();
    this.db.prepare(`UPDATE team_coverage_grants SET revoked_by=?, revoked_at=?
      WHERE merchant_id=? AND id=? AND revoked_at IS NULL AND ends_at>?`).run(employee.name, now, employee.merchantId, id, now);
  }
}
