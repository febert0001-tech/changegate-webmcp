import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TeamError, type CaseHistory, type Employee, type HistoryKind, type TeamCase, type TeamCaseDetail, type TeamCommand } from "./contracts";

type Change = Extract<TeamCommand, { action: "record" | "assign" | "note" | "resolve" }>;
interface SessionRow { username: string; merchantId: string; passwordVersion: string }

const caseColumns = `id, reference, revision, assignee, assignee_name AS assigneeName, status,
  finding, next_action AS nextAction, updated_at AS updatedAt`;

export class TeamStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS team_cases (
          merchant_id TEXT NOT NULL, id TEXT NOT NULL, reference TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          assignee TEXT NOT NULL, assignee_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Investigating', 'Awaiting evidence', 'Resolved')),
          finding TEXT NOT NULL, next_action TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (merchant_id, id)
        );
        CREATE INDEX IF NOT EXISTS team_case_queue ON team_cases(merchant_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS team_history (
          sequence INTEGER PRIMARY KEY, merchant_id TEXT NOT NULL, case_id TEXT NOT NULL,
          actor TEXT NOT NULL, username TEXT NOT NULL, kind TEXT NOT NULL,
          detail TEXT NOT NULL, occurred_at TEXT NOT NULL,
          FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
        );
        CREATE INDEX IF NOT EXISTS team_history_case ON team_history(merchant_id, case_id, sequence);
        CREATE TABLE IF NOT EXISTS team_sessions (
          token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, merchant_id TEXT NOT NULL,
          password_version TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_session_expiry ON team_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS team_revoked_sessions (
          token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_revoked_expiry ON team_revoked_sessions(expires_at);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceSession(digest: string, employee: Employee, passwordVersion: string, expiresAt: number, previous?: string) {
    this.atomic(() => {
      const now = Date.now();
      this.db.prepare("DELETE FROM team_sessions WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM team_revoked_sessions WHERE expires_at <= ?").run(now);
      if (previous) {
        const alreadyRevoked = this.db.prepare("SELECT 1 FROM team_revoked_sessions WHERE token_hash=?").get(previous);
        if (alreadyRevoked) throw new TeamError("SESSION_CHANGED", 409);
        this.revokeActiveSession(previous);
      }
      this.db.prepare("INSERT INTO team_sessions VALUES (?, ?, ?, ?, ?)")
        .run(digest, employee.username, employee.merchantId, passwordVersion, expiresAt);
    });
  }

  getSession(digest: string) {
    return this.db.prepare(`SELECT username, merchant_id AS merchantId, password_version AS passwordVersion
      FROM team_sessions WHERE token_hash=? AND expires_at>?`).get(digest, Date.now()) as SessionRow | undefined;
  }

  private revokeActiveSession(digest: string) {
    // Keep the original token's expiry so a competing sign-in cannot reuse it.
    const previous = this.db.prepare("DELETE FROM team_sessions WHERE token_hash=? RETURNING expires_at").get(digest);
    if (typeof previous?.expires_at === "number") {
      this.db.prepare("INSERT INTO team_revoked_sessions VALUES (?, ?)").run(digest, previous.expires_at);
    }
  }

  revokeSession(digest: string) {
    this.atomic(() => this.revokeActiveSession(digest));
  }

  list(employee: Employee): TeamCase[] {
    return this.db.prepare(`SELECT ${caseColumns} FROM team_cases
      WHERE merchant_id=? ORDER BY updated_at DESC, id`).all(employee.merchantId) as unknown as TeamCase[];
  }

  open(employee: Employee, id: string): TeamCaseDetail {
    const row = this.db.prepare(`SELECT ${caseColumns},
        (SELECT json_group_array(json_object(
          'sequence', sequence, 'actor', actor, 'username', username, 'kind', kind, 'detail', detail, 'occurredAt', occurred_at
        )) FROM (SELECT * FROM team_history WHERE merchant_id=c.merchant_id AND case_id=c.id ORDER BY sequence)) AS history
      FROM team_cases AS c WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as (TeamCase & { history: string }) | undefined;
    if (!row) throw new TeamError("CASE_NOT_FOUND", 404);
    const { history, ...item } = row;
    return { case: item, history: JSON.parse(history) as CaseHistory[] };
  }

  private addEvent(employee: Employee, id: string, kind: HistoryKind, detail: string, time: string) {
    this.db.prepare(`INSERT INTO team_history(merchant_id, case_id, actor, username, kind, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(employee.merchantId, id, employee.name, employee.username, kind, detail, time);
  }

  create(employee: Employee, reference: string) {
    return this.atomic(() => {
      const id = randomUUID();
      const time = this.now();
      this.db.prepare(`INSERT INTO team_cases VALUES (?, ?, ?, 1, ?, ?, 'Investigating', '', '', ?)`)
        .run(employee.merchantId, id, reference, employee.username, employee.name, time);
      this.addEvent(employee, id, "Opened", "Initial owner: " + employee.name, time);
      return this.open(employee, id);
    });
  }

  change(employee: Employee, command: Change, roster: readonly Employee[]) {
    return this.atomic(() => {
      const current = this.open(employee, command.id).case;
      if (current.revision !== command.revision) throw new TeamError("CASE_CHANGED", 409);
      if (current.status === "Resolved") throw new TeamError("CASE_RESOLVED", 409);
      const next = { ...current };
      let kind: HistoryKind;
      let detail: string;
      switch (command.action) {
        case "record":
          next.finding = command.finding;
          next.nextAction = command.nextAction;
          next.status = command.status;
          kind = "Recorded finding";
          detail = ["Status: " + next.status, "Finding: " + next.finding, "Next action: " + next.nextAction].join("\n");
          break;
        case "assign": {
          const assignee = roster.find((entry) => entry.username === command.assignee && entry.merchantId === employee.merchantId);
          if (!assignee) throw new TeamError("ASSIGNEE_UNAVAILABLE", 422);
          next.assignee = assignee.username;
          next.assigneeName = assignee.name;
          kind = "Assigned";
          detail = current.assigneeName + " → " + next.assigneeName;
          break;
        }
        case "note":
          kind = "Added note";
          detail = command.note;
          break;
        case "resolve":
          if (!current.finding || !current.nextAction) throw new TeamError("FINDING_REQUIRED", 422);
          next.status = "Resolved";
          kind = "Resolved";
          detail = "Case marked resolved.";
          break;
      }
      const time = this.now();
      this.db.prepare(`UPDATE team_cases SET revision=revision+1, status=?, assignee=?, assignee_name=?,
        finding=?, next_action=?, updated_at=? WHERE merchant_id=? AND id=?`)
        .run(next.status, next.assignee, next.assigneeName, next.finding, next.nextAction, time, employee.merchantId, current.id);
      this.addEvent(employee, current.id, kind, detail, time);
      return this.open(employee, current.id);
    });
  }
}
