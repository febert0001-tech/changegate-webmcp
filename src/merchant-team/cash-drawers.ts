import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { demoMerchant } from "./demo-shift";
import { demoRegister } from "./demo-sales";
import { TeamError } from "./error";
import { canReview } from "./refund-requests";

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

  active(employee: Employee, scope: Register) {
    return this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
      WHERE merchant_id=? AND location=? AND register=? AND first_count IS NULL`)
      .get(employee.merchantId, scope.location, scope.register) as DrawerRow | undefined;
  }

  assigned(employee: Employee) {
    const scope = demoRegister(employee);
    if (!scope) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    return scope;
  }

  private assertAccess(employee: Employee, row?: Register) {
    if (employee.merchantId !== demoMerchant) throw new TeamError("DRAWER_NOT_FOUND", 404);
    if (canReview(employee.role)) return;
    const scope = this.assigned(employee);
    if (row && (scope.location !== row.location || scope.register !== row.register))
      throw new TeamError("DRAWER_NOT_FOUND", 404);
  }

  private get(employee: Employee, id: string) {
    const row = this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as DrawerRow | undefined;
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

  view(employee: Employee, id?: string): CashDrawerView {
    this.assertAccess(employee);
    const scope = demoRegister(employee);
    const rows = (scope
      ? this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers
          WHERE merchant_id=? AND location=? AND register=? ORDER BY rowid DESC`)
        .all(employee.merchantId, scope.location, scope.register)
      : this.db.prepare(`SELECT ${this.columns} FROM team_cash_drawers WHERE merchant_id=? ORDER BY rowid DESC`)
        .all(employee.merchantId)) as unknown as DrawerRow[];
    const active = rows.find(row => !row.firstCount);
    const row = id ? this.get(employee, id) : active ?? rows[0];
    return { drawers: rows.map(summary), activeId: active?.id ?? null, drawer: row ? {
      ...summary(row), opening: JSON.parse(row.opened) as Count, report: this.report(employee, row),
    } : null };
  }

  open(employee: Employee, id: string, cents: number) {
    const scope = this.assigned(employee);
    const earlier = this.db.prepare("SELECT id FROM team_cash_drawers WHERE merchant_id=? AND id=?")
      .get(employee.merchantId, id);
    if (earlier) {
      const row = this.get(employee, id);
      if ((JSON.parse(row.opened) as Count).cents !== cents) throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
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
