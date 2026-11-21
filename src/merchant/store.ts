import { DatabaseSync } from "node:sqlite";
import { MerchantError, type CaseStatus, type MerchantCase, type MerchantCaseDetail, type MerchantEvent } from "./contracts";

export interface CaseRow {
  id: string;
  order_id: string;
  capture_id: string;
  amount_cents: number;
  currency: "USD";
  version: number;
  status: CaseStatus;
  decision: "APPROVED" | "REJECTED" | null;
  reviewer: string | null;
  decision_at: string | null;
  request_id: string | null;
  submitted_at: string | null;
  refund_id: string | null;
  observation: string | null;
  issue: string | null;
}

export function projectCase(row: CaseRow): MerchantCase {
  return {
    id: row.id, orderId: row.order_id, captureId: row.capture_id, amountCents: row.amount_cents,
    currency: row.currency, version: row.version, status: row.status, decision: row.decision,
    reviewer: row.reviewer, decisionAt: row.decision_at, submittedAt: row.submitted_at,
    refundId: row.refund_id, observation: row.observation ? JSON.parse(row.observation) as MerchantCase["observation"] : null,
    issue: row.issue,
  };
}

export class MerchantStore {
  readonly db: DatabaseSync;

  constructor(path: string, readonly merchantId: string, mode: string) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS merchant_binding (id INTEGER PRIMARY KEY CHECK (id = 1), merchant_id TEXT NOT NULL, mode TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS merchant_cases (
          id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, order_id TEXT NOT NULL, capture_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), currency TEXT NOT NULL CHECK(currency = 'USD'),
          version INTEGER NOT NULL, status TEXT NOT NULL, decision TEXT, reviewer TEXT, decision_at TEXT,
          request_id TEXT UNIQUE, submitted_at TEXT, refund_id TEXT UNIQUE, observation TEXT, issue TEXT
        );
        CREATE INDEX IF NOT EXISTS merchant_capture_cases ON merchant_cases(merchant_id, capture_id);
        CREATE TABLE IF NOT EXISTS merchant_events (
          sequence INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES merchant_cases(id),
          actor TEXT NOT NULL, type TEXT NOT NULL, lifecycle TEXT NOT NULL, occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS merchant_case_events ON merchant_events(case_id, sequence);
      `);
      this.db.prepare("INSERT OR IGNORE INTO merchant_binding VALUES (1, ?, ?)").run(merchantId, mode);
      const binding = this.db.prepare("SELECT merchant_id, mode FROM merchant_binding WHERE id=1").get();
      if (binding?.merchant_id !== merchantId || binding.mode !== mode) throw new MerchantError("DATABASE_BINDING_MISMATCH", 503);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  atomic<T>(work: () => T): T {
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

  close() {
    this.db.close();
  }

  get(id: string): CaseRow {
    const row = this.db.prepare("SELECT * FROM merchant_cases WHERE id=? AND merchant_id=?")
      .get(id, this.merchantId) as CaseRow | undefined;
    if (!row) throw new MerchantError("CASE_NOT_FOUND", 404);
    return row;
  }

  attempts(captureId: string): CaseRow[] {
    return this.db.prepare(`
      SELECT * FROM merchant_cases WHERE merchant_id=? AND capture_id=? AND request_id IS NOT NULL ORDER BY rowid
    `).all(this.merchantId, captureId) as unknown as CaseRow[];
  }

  queue(): MerchantCase[] {
    return (this.db.prepare(`
      SELECT * FROM merchant_cases WHERE merchant_id=?
      ORDER BY CASE status WHEN 'UNCERTAIN' THEN 0 WHEN 'SUBMITTED' THEN 1 WHEN 'PENDING' THEN 2 WHEN 'FAILED' THEN 3 ELSE 4 END, rowid DESC
    `).all(this.merchantId) as unknown as CaseRow[]).map(projectCase);
  }

  event(id: string, actor: string, type: string, lifecycle: CaseStatus, occurredAt: string) {
    this.db.prepare("INSERT INTO merchant_events(case_id, actor, type, lifecycle, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, actor, type, lifecycle, occurredAt);
  }

  detail(id: string): MerchantCaseDetail {
    // One SQLite statement reads one snapshot, including when a worker commits a status and its event concurrently.
    const row = this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM merchant_events WHERE case_id=c.id) AS event_count,
        (SELECT json_group_array(json_object(
          'sequence', sequence, 'actor', actor, 'type', type, 'lifecycle', lifecycle, 'occurredAt', occurred_at
        )) FROM (
          SELECT sequence, actor, type, lifecycle, occurred_at FROM merchant_events
          WHERE case_id=c.id ORDER BY sequence DESC LIMIT 50
        )) AS event_json
      FROM merchant_cases AS c WHERE c.id=? AND c.merchant_id=?
    `).get(id, this.merchantId) as (CaseRow & { event_count: number; event_json: string }) | undefined;
    if (!row) throw new MerchantError("CASE_NOT_FOUND", 404);
    const events = (JSON.parse(row.event_json) as MerchantEvent[]).reverse();
    return {
      case: projectCase(row),
      audit: { totalEvents: row.event_count, truncated: row.event_count > events.length, events },
    };
  }
}
