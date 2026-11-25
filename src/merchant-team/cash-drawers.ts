import type { DatabaseSync } from "node:sqlite";
import type { Employee, TeamCaseDetail } from "./contracts";
import { demoLocations, demoMerchant } from "./demo-shift";
import { demoRegister } from "./demo-sales";
import { discountPolicy } from "./discount-contracts";
import { TeamError } from "./error";
import { canReplayOvernight, overnightReplayLocation, overnightReplayWeek } from "./overnight-replay";
import { canReview } from "./refund-requests";
import { addCashWeekDays, cashStoreDate, cashTimeZone, cashWeekMonday, drawerDispositions, type CashWeek, type DrawerDisposition } from "./weekly-cash-review";

type Register = { location: string; register: string };
type Stamp = { actor: string; at: string };
type Count = Stamp & { cents: number };
type Entry = Stamp & { id: string; kind: "sale" | "payout" | "addition" | "removal"; cents: number; note: string };
type FollowUp = Stamp & { id: string; cents: number | null; note: string };
type DrawerRow = Register & { id: string; opened: string; firstCount: string | null; caseId: string | null };
type DrawerSummary = Register & { id: string; openedAt: string; isClosed: boolean };
export type CashDrawerView = {
  drawers: DrawerSummary[];
  activeId: string | null;
  drawer: (DrawerSummary & { opening: Count; report: {
    firstCount: Count; expected: number; variance: number; entries: Entry[]; followUps: FollowUp[]; caseId: string | null;
  } | null }) | null;
};

const summary = ({ id, location, register, opened, firstCount }: DrawerRow): DrawerSummary =>
  ({ id, location, register, openedAt: (JSON.parse(opened) as Count).at, isClosed: firstCount !== null });
const latestRecount = (entries: FollowUp[]) =>
  entries.findLast((entry): entry is FollowUp & { cents: number } => entry.cents !== null) ?? null;

function caseReview(detail: TeamCaseDetail) {
  const event = detail.history.findLast(({ kind }) => kind === "Resolved" || kind === "Recorded finding" || kind === "Added note");
  const disposition = event?.kind === "Resolved" ? drawerDispositions.find(value => value === event.detail) : undefined;
  return { id: detail.case.id, status: detail.case.status, reviewer: event?.actor ?? null, disposition: disposition ?? null };
}

export class CashDrawers {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_cash_drawers (
        merchant_id TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL, register TEXT NOT NULL,
        opened TEXT NOT NULL, first_count TEXT, case_id TEXT,
        PRIMARY KEY (merchant_id, id), UNIQUE (merchant_id, case_id),
        FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS team_cash_drawer_active
        ON team_cash_drawers(merchant_id, location, register) WHERE first_count IS NULL;
      CREATE TABLE IF NOT EXISTS team_cash_drawer_entries (
        merchant_id TEXT NOT NULL, drawer_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (merchant_id, kind, id),
        FOREIGN KEY (merchant_id, drawer_id) REFERENCES team_cash_drawers(merchant_id, id)
      );
      CREATE TABLE IF NOT EXISTS team_cash_drawer_followups (
        merchant_id TEXT NOT NULL, drawer_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (merchant_id, drawer_id, id),
        FOREIGN KEY (merchant_id, drawer_id) REFERENCES team_cash_drawers(merchant_id, id)
      );
    `);
  }

  private readonly columns = "id, location, register, opened, first_count AS firstCount, case_id AS caseId";
  private readonly replay = `COALESCE((SELECT r.id FROM team_overnight_replays r
    WHERE r.merchant_id=team_cash_drawers.merchant_id AND team_cash_drawers.case_id IN (r.open_case_id, r.resolved_case_id)), '')`;

  insertReplayClose(cashier: Employee, id: string, caseId: string, at: string, opening: number, count: number) {
    this.db.prepare("INSERT INTO team_cash_drawers VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cashier.merchantId, id, overnightReplayLocation, "Register 1",
        JSON.stringify({ cents: opening, actor: cashier.name, at }),
        JSON.stringify({ cents: count, actor: cashier.name, at }), caseId);
  }

  active(employee: Employee, scope: Register) {
    return this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
      WHERE merchant_id=? AND location=? AND register=? AND first_count IS NULL`)
      .get(employee.merchantId, scope.location, scope.register) as DrawerRow | undefined;
  }

  assigned(employee: Employee, register?: "harbor-bar") {
    const scope = demoRegister(employee);
    if (!scope) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    return register === "harbor-bar" ? discountPolicy : scope;
  }

  private assertAccess(employee: Employee, row?: Register) {
    if (employee.merchantId !== demoMerchant) throw new TeamError("DRAWER_NOT_FOUND", 404);
    if (canReview(employee.role)) return;
    const scope = this.assigned(employee);
    if (row && ![scope, discountPolicy].some(register => register.location === row.location && register.register === row.register))
      throw new TeamError("DRAWER_NOT_FOUND", 404);
  }

  private get(employee: Employee, id: string) {
    const row = this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
      WHERE merchant_id=? AND id=? AND (? OR ${this.replay}='')`)
      .get(employee.merchantId, id, Number(canReplayOvernight(employee))) as DrawerRow | undefined;
    if (!row) throw new TeamError("DRAWER_NOT_FOUND", 404);
    this.assertAccess(employee, row);
    return row;
  }

  private rows<T>(table: "team_cash_drawer_entries" | "team_cash_drawer_followups", employee: Employee, id: string) {
    return this.db.prepare(`SELECT payload FROM ${table} WHERE merchant_id=? AND drawer_id=? ORDER BY rowid`)
      .all(employee.merchantId, id).map(row => JSON.parse(row.payload as string) as T);
  }

  private report(employee: Employee, row: DrawerRow) {
    if (!row.firstCount) return null;
    const firstCount = JSON.parse(row.firstCount) as Count;
    const entries = this.rows<Entry>("team_cash_drawer_entries", employee, row.id);
    const expected = entries.reduce((total, entry) => total + entry.cents, (JSON.parse(row.opened) as Count).cents);
    return { firstCount, expected, variance: firstCount.cents - expected, entries,
      followUps: this.rows<FollowUp>("team_cash_drawer_followups", employee, row.id), caseId: row.caseId };
  }

  coverageEvidence(employee: Employee, id: string) {
    const row = this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as DrawerRow | undefined;
    if (!row || !row.firstCount) throw new TeamError("DRAWER_NOT_FOUND", 404);
    return { ...summary(row), opening: JSON.parse(row.opened) as Count, report: this.report(employee, row)! };
  }

  view(employee: Employee, id?: string, register?: "harbor-bar"): CashDrawerView {
    this.assertAccess(employee);
    const scope = demoRegister(employee) && this.assigned(employee, register);
    const rows = (scope
      ? this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
          WHERE merchant_id=? AND location=? AND register=? AND ${this.replay}='' ORDER BY rowid DESC`)
        .all(employee.merchantId, scope.location, scope.register)
      : this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers WHERE merchant_id=? AND ${this.replay}='' ORDER BY rowid DESC`)
        .all(employee.merchantId)) as unknown as DrawerRow[];
    const active = rows.find(row => !row.firstCount);
    const row = id ? this.get(employee, id) : active ?? rows[0];
    return { drawers: rows.map(summary), activeId: active?.id ?? null, drawer: row ? {
      ...summary(row), opening: JSON.parse(row.opened) as Count, report: this.report(employee, row),
    } : null };
  }

  week(employee: Employee, week: string | undefined, location: string | undefined,
    openCase: (id: string) => TeamCaseDetail, replay?: string): CashWeek {
    this.assertAccess(employee);
    if (!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    if (replay && !this.db.prepare("SELECT 1 FROM team_overnight_replays WHERE merchant_id=? AND id=?").get(employee.merchantId, replay))
      throw new TeamError("CASE_NOT_FOUND", 404);
    const start = cashWeekMonday(replay ? overnightReplayWeek : week ?? cashStoreDate(this.now()));
    const end = addCashWeekDays(start, 6);
    const records = this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
      WHERE merchant_id=? AND ${this.replay}=? AND json_extract(opened, '$.at')>=? AND json_extract(opened, '$.at')<?
      ORDER BY json_extract(opened, '$.at') DESC, id`).all(employee.merchantId,
        replay ?? "", addCashWeekDays(start, -1), addCashWeekDays(end, 2)) as unknown as DrawerRow[];
    const rows = records.flatMap(row => {
      const item = summary(row);
      const day = cashStoreDate(item.openedAt);
      if (day < start || day > end || (location && item.location !== location)) return [];
      const report = this.report(employee, row);
      return [{ ...item, close: report ? { expected: report.expected, variance: report.variance, firstCount: report.firstCount,
        recount: latestRecount(report.followUps), review: row.caseId ? caseReview(openCase(row.caseId)) : null } : null }];
    });
    return { start, end, timeZone: cashTimeZone, locations: [...new Set([...demoLocations, ...records.map(row => row.location)])], rows };
  }

  resolution(employee: Employee, drawerId: string, disposition: DrawerDisposition | undefined) {
    if (!disposition) throw new TeamError("DRAWER_DISPOSITION_REQUIRED", 422);
    if (disposition === "Recount corrected the count") {
      const report = this.report(employee, this.get(employee, drawerId));
      if (!report || latestRecount(report.followUps)?.cents !== report.expected)
        throw new TeamError("DRAWER_RECOUNT_MISMATCH", 422);
    }
    return disposition;
  }

  open(employee: Employee, id: string, cents: number, register?: "harbor-bar") {
    const scope = this.assigned(employee, register);
    const earlier = this.db.prepare("SELECT id FROM team_cash_drawers WHERE merchant_id=? AND id=?")
      .get(employee.merchantId, id);
    if (earlier) {
      const row = this.get(employee, id);
      if (row.location !== scope.location || row.register !== scope.register || (JSON.parse(row.opened) as Count).cents !== cents)
        throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
      return id;
    }
    const active = this.active(employee, scope);
    if (active) return active.id;
    this.db.prepare("INSERT INTO team_cash_drawers VALUES (?,?,?,?,?,NULL,NULL)")
      .run(employee.merchantId, id, scope.location, scope.register, JSON.stringify(this.count(employee, cents)));
    return id;
  }

  close(employee: Employee, id: string, cents: number) {
    this.assigned(employee);
    this.get(employee, id);
    this.db.prepare("UPDATE team_cash_drawers SET first_count=? WHERE merchant_id=? AND id=? AND first_count IS NULL")
      .run(JSON.stringify(this.count(employee, cents)), employee.merchantId, id);
  }

  private count(employee: Employee, cents: number): Count {
    return { cents, actor: employee.name, at: this.now() };
  }

  private append(employee: Employee, drawerId: string, entry: Entry) {
    const source = entry.kind === "addition" || entry.kind === "removal" ? "movement" : entry.kind;
    const existing = this.db.prepare("SELECT drawer_id, payload FROM team_cash_drawer_entries WHERE merchant_id=? AND kind=? AND id=?")
      .get(employee.merchantId, source, entry.id);
    if (existing) {
      const saved = JSON.parse(existing.payload as string) as Entry;
      if (existing.drawer_id !== drawerId || saved.kind !== entry.kind || saved.cents !== entry.cents || saved.note !== entry.note)
        throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
      return;
    }
    const drawer = this.get(employee, drawerId);
    if (drawer.firstCount) throw new TeamError("DRAWER_CLOSED", 409);
    this.db.prepare("INSERT INTO team_cash_drawer_entries VALUES (?,?,?,?,?)")
      .run(employee.merchantId, drawerId, source, entry.id, JSON.stringify(entry));
  }

  recordActivity(employee: Employee, scope: Register, id: string, kind: "sale" | "payout", cents: number) {
    const drawer = this.active(employee, scope);
    if (drawer) this.append(employee, drawer.id, { id, kind, ...this.count(employee, cents), note: "" });
  }

  movement(employee: Employee, drawerId: string, id: string, kind: "addition" | "removal", cents: number, note: string) {
    this.assigned(employee);
    this.append(employee, drawerId, { id, kind, ...this.count(employee, kind === "addition" ? cents : -cents), note });
  }

  followUp(employee: Employee, drawerId: string, id: string, cents: number | null, note: string) {
    const row = this.get(employee, drawerId);
    if (!row.firstCount) throw new TeamError("DRAWER_INCOMPLETE", 409);
    const previous = this.db.prepare("SELECT payload FROM team_cash_drawer_followups WHERE merchant_id=? AND drawer_id=? AND id=?")
      .get(employee.merchantId, drawerId, id);
    if (previous) {
      const saved = JSON.parse(previous.payload as string) as FollowUp;
      if (saved.cents !== cents || saved.note !== note) throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
      return;
    }
    const entry: FollowUp = { id, cents, note, actor: employee.name, at: this.now() };
    this.db.prepare("INSERT INTO team_cash_drawer_followups VALUES (?,?,?,?)")
      .run(employee.merchantId, drawerId, id, JSON.stringify(entry));
  }

  review(employee: Employee, drawerId: string, create: (variance: number) => string) {
    const row = this.get(employee, drawerId);
    if (!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    if (row.caseId) return;
    const report = this.report(employee, row);
    if (!report || !report.variance) throw new TeamError("DRAWER_NO_DISCREPANCY", 409);
    this.db.prepare("UPDATE team_cash_drawers SET case_id=? WHERE merchant_id=? AND id=?")
      .run(create(report.variance), employee.merchantId, drawerId);
  }

  forCase(employee: Employee, caseId: string) {
    return this.db.prepare("SELECT id FROM team_cash_drawers WHERE merchant_id=? AND case_id=?")
      .get(employee.merchantId, caseId)?.id as string | undefined;
  }
}
