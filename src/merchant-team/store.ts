import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TeamError, type CaseHistory, type Employee, type HistoryKind, type TeamCase, type TeamCaseDetail, type TeamCommand } from "./contracts";

import type { CaseComparison, CaseEvidence, ComparisonEvidence, ImportSummary, RefundFinding, RefundImport, RefundImportResult, Rejection, SavedFinding } from "./refund-csv";

import { summarizeComparison, type ReviewDisposition, type ReviewFindingState } from "./review-summary";

import { RefundAlertStore } from "./refund-alert-store";
import type { AlertEnrollment } from "./refund-alerts";
import { RefundRequestStore } from "./refund-request-store";
import type { RefundDecision, RefundTerms } from "./refund-requests";
import { executionStopped, squareVerification } from "./refund-requests";
import type { SquareSandbox, SquareSaleEvidence } from "./square-sandbox";
import { SquareSubmissionBlocked } from "./square-sandbox";

type ImportRow = ImportSummary & { rejections: string };
type FindingRow = { id: string; importId: string; evidence: string; caseId: string | null };
const importColumns = `id, imported_at AS importedAt, accepted_count AS acceptedCount,
  rejected_count AS rejectedCount, finding_count AS findingCount`;
const findingColumns = "id, import_id AS importId, evidence, case_id AS caseId";
const nextAction = "Review the source rows and verify the refund with the processor.";
const projectFinding = (row: FindingRow): SavedFinding => ({
  ...JSON.parse(row.evidence) as RefundFinding, id: row.id, caseId: row.caseId,
});

function comparisonSignature(comparison: ComparisonEvidence, findings: RefundFinding[], rejections: Rejection[]) {
  const evidence = findings.map(({ kind, rows, explanation, differenceCents }) =>
    [kind, rows, explanation, differenceCents ?? null]);
  return JSON.stringify([comparison.period.start, comparison.period.end, comparison.exact, evidence, rejections]);
}

type Change = Extract<TeamCommand, { action: "record" | "assign" | "note" | "resolve" }>;
interface SessionRow { username: string; merchantId: string; passwordVersion: string }

const caseColumns = `id, reference, revision, assignee, assignee_name AS assigneeName, status,
  finding, next_action AS nextAction, updated_at AS updatedAt`;

export class TeamStore {
  private readonly db: DatabaseSync;
  readonly refundRequests: RefundRequestStore;
  readonly alerts: RefundAlertStore;
  private readonly squareInFlight = new Set<string>();

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
        CREATE TABLE IF NOT EXISTS team_refund_imports (
          merchant_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, imported_at TEXT NOT NULL,
          accepted_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, finding_count INTEGER NOT NULL,
          rejections TEXT NOT NULL, PRIMARY KEY (merchant_id, id), UNIQUE (merchant_id, fingerprint)
        );
        CREATE TABLE IF NOT EXISTS team_refund_comparisons (
          merchant_id TEXT NOT NULL, import_id TEXT NOT NULL, evidence TEXT NOT NULL,
          PRIMARY KEY (merchant_id, import_id),
          FOREIGN KEY (merchant_id, import_id) REFERENCES team_refund_imports(merchant_id, id)
        );
        CREATE TABLE IF NOT EXISTS team_refund_findings (
          merchant_id TEXT NOT NULL, id TEXT NOT NULL, import_id TEXT NOT NULL, evidence TEXT NOT NULL, case_id TEXT,
          PRIMARY KEY (merchant_id, id), UNIQUE (merchant_id, case_id),
          FOREIGN KEY (merchant_id, import_id) REFERENCES team_refund_imports(merchant_id, id),
          FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
        );
        CREATE TABLE IF NOT EXISTS team_review_dispositions (
          merchant_id TEXT NOT NULL, finding_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
          disposition TEXT NOT NULL, reviewer TEXT NOT NULL, username TEXT NOT NULL, recorded_at TEXT NOT NULL, note TEXT NOT NULL,
          PRIMARY KEY (merchant_id, finding_id, revision),
          FOREIGN KEY (merchant_id, finding_id) REFERENCES team_refund_findings(merchant_id, id)
        );
        CREATE INDEX IF NOT EXISTS team_findings_import ON team_refund_findings(merchant_id, import_id);
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
        CREATE TABLE IF NOT EXISTS team_signin_attempts (
          client_hash TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_revoked_sessions (
          token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_revoked_expiry ON team_revoked_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS team_signout_recovery (
          token_hash TEXT PRIMARY KEY REFERENCES team_revoked_sessions(token_hash) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS team_session_replacements (
          token_hash TEXT PRIMARY KEY REFERENCES team_revoked_sessions(token_hash) ON DELETE CASCADE,
          replacement_hash TEXT NOT NULL
        );
      `);
      this.refundRequests = new RefundRequestStore(this.db, this.now);
      this.alerts = new RefundAlertStore(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  createRefundRequest(employee: Employee, token: string, submissionId: string, terms: RefundTerms, evidence?: SquareSaleEvidence) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      return this.refundRequests.create(employee, submissionId, terms, this.alerts, evidence);
    });
  }

  async executeSquareRefund(employee: Employee, token: string, id: string, square: SquareSandbox | undefined, verifyOnly: boolean) {
    this.requireActiveSession(employee, token);
    const state = this.refundRequests.squareExecution(employee, id);
    const completed = squareVerification(state.request)?.result;
    if (completed === "Verified" || completed === "Failed" || executionStopped(state.request)) return state.request;
    if (!square?.supports(employee.merchantId, state.request.sale ?? undefined)) {
      throw new TeamError("SQUARE_NOT_CONNECTED", 503);
    }
    let response = state.response;
    if (!response && !verifyOnly) {
      let evidence: SquareSaleEvidence | undefined;
      if (!state.attempt) {
        try {
          evidence = await square.lookup(state.request.terms.reference);
        } catch (error) {
          if (!(error instanceof TeamError) ||
              (error.code !== "SQUARE_SALE_INELIGIBLE" && error.code !== "SQUARE_PRIOR_REFUND_FAILED")) throw error;
          const reason = error.code === "SQUARE_PRIOR_REFUND_FAILED"
            ? "Square blocks additional refunds because an earlier refund failed on this payment."
            : "The sale is outside Square’s refund window or has reached its refund limit.";
          return this.atomic(() => {
            this.requireActiveSession(employee, token);
            return this.refundRequests.stopSquare(employee, id, reason);
          });
        }
      }
      const { attempt, response: saved, started, request } = this.atomic(() => {
        this.requireActiveSession(employee, token);
        return this.refundRequests.startSquare(employee, id, this.alerts, evidence);
      });
      response = saved;
      if (!response) {
        if (!attempt || executionStopped(request) || this.squareInFlight.has(id)) return this.refundRequests.open(employee, id);
        // The local retry window includes the instant exactly 15 minutes after the original attempt.
        if (Date.parse(this.now()) - Date.parse(attempt.startedAt) > 15 * 60_000) {
          throw new TeamError("SQUARE_RECONCILIATION_REQUIRED", 409);
        }
        this.squareInFlight.add(id);
        try {
          const result = await square.submit(attempt.terms).catch((error: unknown) => error instanceof SquareSubmissionBlocked ? error : null);
          if (started && result instanceof SquareSubmissionBlocked) {
            return this.atomic(() => this.refundRequests.stopSquare(employee, id, result.reason, true));
          }
          response = this.atomic(() => this.refundRequests.recordSquareResponse(employee, id,
            result instanceof SquareSubmissionBlocked ? null : result)) ?? undefined;
        } finally {
          this.squareInFlight.delete(id);
        }
      }
    }
    if (!response) return this.refundRequests.open(employee, id);
    const readback = await square.verify(response.id).catch(() => null);
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      return this.refundRequests.recordSquareLookup(employee, id, readback);
    });
  }

  decideRefundRequest(employee: Employee, token: string, id: string, decision: RefundDecision) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      return this.refundRequests.decide(employee, id, decision);
    });
  }

  setRefundPolicy(employee: Employee, token: string, thresholdCents: number) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      return this.refundRequests.setPolicy(employee, thresholdCents);
    });
  }

  enrollRefundAlerts(employee:Employee,token:string,model:AlertEnrollment) {
    return this.atomic(()=>{
      this.requireActiveSession(employee,token);
      this.alerts.enroll(employee,model);
    });
  }

  removeRefundAlerts(employee:Employee,token:string,endpoint:string) {
    return this.atomic(()=>{
      this.requireActiveSession(employee,token);
      this.alerts.remove(employee,endpoint);
    });
  }

  reportCashPayout(employee: Employee, token: string, id: string) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      return this.refundRequests.reportCash(employee,id);
    });
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

  allowSignIn(client: string) {
    const window = Math.floor(Date.now() / (5 * 60 * 1000));
    return this.atomic(() => {
      this.db.prepare("DELETE FROM team_signin_attempts WHERE window < ?").run(window);
      const row = this.db.prepare(`INSERT INTO team_signin_attempts VALUES (?, ?, 1)
        ON CONFLICT(client_hash) DO UPDATE SET attempts=attempts+1 WHERE attempts < 30
        RETURNING attempts`).get(client, window);
      return Boolean(row);
    });
  }

  pruneSessions(roster: readonly SessionRow[]) {
    this.db.prepare(`DELETE FROM team_sessions
      WHERE expires_at <= ? OR NOT EXISTS (
        SELECT 1 FROM json_each(?) AS member
        WHERE json_extract(member.value, '$.username') = team_sessions.username
          AND json_extract(member.value, '$.merchantId') = team_sessions.merchant_id
          AND json_extract(member.value, '$.passwordVersion') = team_sessions.password_version
      )`).run(Date.now(), JSON.stringify(roster));
  }

  replaceSession(digest: string, employee: Employee, passwordVersion: string, expiresAt: number,
    previous: string | undefined, recoverSession: boolean) {
    this.atomic(() => {
      const now = Date.now();
      this.db.prepare("DELETE FROM team_sessions WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM team_revoked_sessions WHERE expires_at <= ?").run(now);
      if (previous) {
        const alreadyRevoked = this.db.prepare("SELECT 1 FROM team_revoked_sessions WHERE token_hash=?").get(previous);
        if (alreadyRevoked) {
          this.recoverSession(previous, employee, recoverSession);
        } else if (this.revokeActiveSession(previous)) {
          this.db.prepare("INSERT INTO team_session_replacements VALUES (?, ?)").run(previous, digest);
        }
      }
      this.db.prepare("INSERT INTO team_sessions VALUES (?, ?, ?, ?, ?)")
        .run(digest, employee.username, employee.merchantId, passwordVersion, expiresAt);
    });
  }

  // The losing regular sign-in cannot overwrite a winning response. A deliberate retry with
  // the winning employee's credentials may revoke the unseen replacement and issue one new token.
  private recoverSession(previous: string, employee: Employee, allowed: boolean) {
    const signedOut = this.db.prepare("SELECT 1 FROM team_signout_recovery WHERE token_hash=?").get(previous);
    const replacement = this.db.prepare(`SELECT s.token_hash FROM team_session_replacements AS r
      JOIN team_sessions AS s ON s.token_hash=r.replacement_hash
      WHERE r.token_hash=? AND s.username=? AND s.merchant_id=? AND s.expires_at>?`)
      .get(previous, employee.username, employee.merchantId, Date.now())?.token_hash;
    if (!signedOut && typeof replacement !== "string") throw new TeamError("SESSION_CHANGED", 409);
    if (!allowed) throw new TeamError("SIGN_IN_RECOVERY_REQUIRED", 409);
    if (signedOut) this.db.prepare("DELETE FROM team_signout_recovery WHERE token_hash=?").run(previous);
    if (typeof replacement === "string") {
      this.revokeActiveSession(replacement);
      this.db.prepare("DELETE FROM team_session_replacements WHERE token_hash=?").run(previous);
    }
  }

  getSession(digest: string) {
    return this.db.prepare(`SELECT username, merchant_id AS merchantId, password_version AS passwordVersion
      FROM team_sessions WHERE token_hash=? AND expires_at>?`).get(digest, Date.now()) as SessionRow | undefined;
  }

  private revokeActiveSession(digest: string) {
    // Keep the original token's expiry so a competing sign-in cannot reuse it.
    const previous = this.db.prepare("DELETE FROM team_sessions WHERE token_hash=? RETURNING expires_at").get(digest);
    if (typeof previous?.expires_at !== "number") return false;
    this.db.prepare("INSERT INTO team_revoked_sessions VALUES (?, ?)").run(digest, previous.expires_at);
    return true;
  }

  revokeSession(digest: string) {
    this.atomic(() => {
      if (!this.revokeActiveSession(digest)) throw new TeamError("SESSION_CHANGED", 409);
      this.db.prepare("INSERT INTO team_signout_recovery VALUES (?)").run(digest);
    });
  }

  list(employee: Employee): TeamCase[] {
    const rows = this.db.prepare(`SELECT ${caseColumns},
        (SELECT json_extract(evidence, '$.differenceCents') FROM team_refund_findings
         WHERE merchant_id=c.merchant_id AND case_id=c.id) AS differenceCents
      FROM team_cases AS c WHERE merchant_id=? ORDER BY updated_at DESC, id`)
      .all(employee.merchantId) as unknown as (Omit<TeamCase, "differenceCents"> & { differenceCents: number | null })[];
    return rows.map(({ differenceCents, ...item }) => ({ ...item, ...(differenceCents !== null && { differenceCents }) }));
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
    const linked = this.db.prepare(`SELECT ${findingColumns} FROM team_refund_findings
      WHERE merchant_id=? AND case_id=?`).get(employee.merchantId, id) as FindingRow | undefined;
    const comparison = linked && this.db.prepare(`SELECT json_remove(evidence, '$.exact') AS evidence
      FROM team_refund_comparisons WHERE merchant_id=? AND import_id=?`).get(employee.merchantId, linked.importId)?.evidence;
    const evidence: CaseEvidence | undefined = linked ? {
      importId: linked.importId, finding: projectFinding(linked),
      ...(typeof comparison === "string" && { comparison: JSON.parse(comparison) as CaseComparison }),
    } : undefined;
    return { case: item, history: JSON.parse(history) as CaseHistory[], ...(evidence && { evidence }) };
  }

  listImports(employee: Employee): ImportSummary[] {
    return this.db.prepare(`SELECT ${importColumns} FROM team_refund_imports
      WHERE merchant_id=? ORDER BY imported_at DESC, id`).all(employee.merchantId) as unknown as ImportSummary[];
  }

  openImport(employee: Employee, id: string): RefundImport {
    const row = this.db.prepare(`SELECT ${importColumns}, rejections FROM team_refund_imports WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as ImportRow | undefined;
    if (!row) throw new TeamError("IMPORT_NOT_FOUND", 404);
    const { rejections, ...summary } = row;
    const findings = this.db.prepare(`SELECT ${findingColumns} FROM team_refund_findings
      WHERE merchant_id=? AND import_id=? ORDER BY rowid`).all(employee.merchantId, id) as unknown as FindingRow[];
    const comparison = this.db.prepare("SELECT evidence FROM team_refund_comparisons WHERE merchant_id=? AND import_id=?")
      .get(employee.merchantId, id)?.evidence;
    return { summary, findings: findings.map(projectFinding), rejections: JSON.parse(rejections) as Rejection[],
      ...(typeof comparison === "string" && { comparison: JSON.parse(comparison) as ComparisonEvidence }) };
  }

  openReviewSummary(employee: Employee, id: string) {
    const batch = this.openImport(employee, id);
    if (!batch.comparison) throw new TeamError("IMPORT_NOT_FOUND", 404);
    const rows = this.db.prepare(`SELECT f.id, f.case_id AS caseId, c.assignee_name AS assigneeName, c.status AS caseStatus,
      (SELECT json_object('revision', d.revision, 'disposition', d.disposition, 'reviewer', d.reviewer,
        'recordedAt', d.recorded_at, 'note', d.note)
        FROM team_review_dispositions AS d WHERE d.merchant_id=f.merchant_id AND d.finding_id=f.id
        ORDER BY d.revision DESC LIMIT 1) AS decision
      FROM team_refund_findings AS f
      LEFT JOIN team_cases AS c ON c.merchant_id=f.merchant_id AND c.id=f.case_id
      WHERE f.merchant_id=? AND f.import_id=?`).all(employee.merchantId, id) as unknown as
      ({ id: string; decision: string | null } & Omit<ReviewFindingState, "decision">)[];
    const states = new Map(rows.map(({ id, decision, ...item }) => [id, {
      ...item, decision: decision === null ? null : JSON.parse(decision) as ReviewDisposition,
    }]));
    return summarizeComparison(batch, states);
  }

  recordDisposition(employee: Employee, token: string, command: Extract<TeamCommand, { action: "recordDisposition" }>) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      const { id, findingId, expectedRevision, disposition, note } = command;
      const finding = this.db.prepare(`SELECT 1 FROM team_refund_findings AS f
        JOIN team_refund_comparisons AS c ON c.merchant_id=f.merchant_id AND c.import_id=f.import_id
        WHERE f.merchant_id=? AND f.import_id=? AND f.id=?`).get(employee.merchantId, id, findingId);
      if (!finding) throw new TeamError("FINDING_NOT_FOUND", 404);
      const latest = this.db.prepare(`SELECT revision FROM team_review_dispositions
        WHERE merchant_id=? AND finding_id=? ORDER BY revision DESC LIMIT 1`).get(employee.merchantId, findingId);
      if ((latest?.revision ?? 0) !== expectedRevision) throw new TeamError("DISPOSITION_CHANGED", 409);
      this.db.prepare("INSERT INTO team_review_dispositions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(employee.merchantId, findingId, expectedRevision + 1, disposition, employee.name, employee.username, this.now(), note);
      return this.openReviewSummary(employee, id);
    });
  }

  importRefunds(employee: Employee, token: string, raw: string,
    review: () => { accepted: unknown[]; findings: RefundFinding[]; rejections: Rejection[]; comparison?: ComparisonEvidence }): RefundImportResult {
    const legacyFingerprint = createHash("sha256").update(raw).digest("hex");
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      const lookup = this.db.prepare("SELECT id FROM team_refund_imports WHERE merchant_id=? AND fingerprint=?");
      const oldId = lookup.get(employee.merchantId, legacyFingerprint)?.id;
      const legacy = typeof oldId === "string" ? this.openImport(employee, oldId) : undefined;
      if (legacy && !legacy.comparison) return { batch: legacy, existing: true };
      const { accepted, findings, rejections, comparison } = review();
      let fingerprint = legacyFingerprint;
      if (comparison) {
        // File names are provenance, not comparison identity. Bind the declared period and
        // saved interpretation so corrected mappings or a different week cannot reuse stale evidence.
        const signature = comparisonSignature(comparison, findings, rejections);
        if (legacy?.comparison) {
          const previous = comparisonSignature(legacy.comparison, legacy.findings, legacy.rejections);
          if (signature === previous) return { batch: legacy, existing: true };
        }
        fingerprint = createHash("sha256").update("refund-comparison-v2\0").update(legacyFingerprint).update(signature).digest("hex");
        const saved = lookup.get(employee.merchantId, fingerprint)?.id;
        if (typeof saved === "string") return { batch: this.openImport(employee, saved), existing: true };
      }
      if (!accepted.length) throw new TeamError("CSV_NO_ACCEPTED_ROWS", 422);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO team_refund_imports VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(employee.merchantId, id, fingerprint, this.now(), accepted.length, rejections.length,
          findings.length, JSON.stringify(rejections));
      if (comparison) this.db.prepare("INSERT INTO team_refund_comparisons VALUES (?, ?, ?)")
        .run(employee.merchantId, id, JSON.stringify(comparison));
      const insert = this.db.prepare("INSERT INTO team_refund_findings VALUES (?, ?, ?, ?, NULL)");
      for (const finding of findings) insert.run(employee.merchantId, randomUUID(), id, JSON.stringify(finding));
      return { batch: this.openImport(employee, id), existing: false };
    });
  }

  assignFinding(employee: Employee, token: string, id: string, assignee: Employee) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      const row = this.db.prepare(`SELECT ${findingColumns} FROM team_refund_findings WHERE merchant_id=? AND id=?`)
        .get(employee.merchantId, id) as FindingRow | undefined;
      if (!row) throw new TeamError("FINDING_NOT_FOUND", 404);
      if (row.caseId) return this.open(employee, row.caseId);
      if (assignee.merchantId !== employee.merchantId) throw new TeamError("ASSIGNEE_UNAVAILABLE", 422);
      const finding = projectFinding(row);
      const caseId = randomUUID();
      const now = this.now();
      this.db.prepare(`INSERT INTO team_cases VALUES (?, ?, ?, 1, ?, ?, 'Awaiting evidence', ?, ?, ?)`)
        .run(employee.merchantId, caseId, finding.rows[0]!.reference, assignee.username, assignee.name,
          finding.explanation, nextAction, now);
      this.db.prepare("UPDATE team_refund_findings SET case_id=? WHERE merchant_id=? AND id=?")
        .run(caseId, employee.merchantId, id);
      this.addEvent(employee, caseId, "Opened", "Case opened from a refund import.", now);
      this.addEvent(employee, caseId, "Imported evidence", finding.kind + " · Source lines " +
        finding.rows.map(({ line, side }) => side ? side + " " + line : String(line)).join(", "), now);
      this.addEvent(employee, caseId, "Assigned", assignee.name, now);
      return this.open(employee, caseId);
    });
  }

  private addEvent(employee: Employee, id: string, kind: HistoryKind, detail: string, time: string) {
    this.db.prepare(`INSERT INTO team_history(merchant_id, case_id, actor, username, kind, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(employee.merchantId, id, employee.name, employee.username, kind, detail, time);
  }

  private requireActiveSession(employee: Employee, token: string) {
    const session = this.getSession(token);
    if (session?.username !== employee.username || session.merchantId !== employee.merchantId) {
      throw new TeamError("SIGN_IN_REQUIRED", 401);
    }
  }

  create(employee: Employee, reference: string, token: string) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
      const id = randomUUID();
      const time = this.now();
      this.db.prepare(`INSERT INTO team_cases VALUES (?, ?, ?, 1, ?, ?, 'Investigating', '', '', ?)`)
        .run(employee.merchantId, id, reference, employee.username, employee.name, time);
      this.addEvent(employee, id, "Opened", "Initial owner: " + employee.name, time);
      return this.open(employee, id);
    });
  }

  change(employee: Employee, command: Change, roster: readonly Employee[], token: string) {
    return this.atomic(() => {
      this.requireActiveSession(employee, token);
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
