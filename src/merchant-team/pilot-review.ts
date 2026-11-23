import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { CaseHistory, Employee, HistoryKind } from "./contracts";
import { fictionalPilotFile } from "./pilot-fixtures";
import type { PilotCommand, pilotFile, pilotDecisions, pilotOutcomes } from "./pilot-contracts";
import { TeamError } from "./error";
import { canReview } from "./refund-requests";
import { compareReviewedRefunds } from "./refund-comparison";
import { inspectRefundCsv, reviewRefundCsv, type EvidenceRow, type ExportSide, type RefundFinding } from "./refund-csv";
import { addCashWeekDays } from "./weekly-cash-review";

type Stamp = { actor: string; at: string };
type Source = { name: string; key: string; review: ReturnType<typeof reviewRefundCsv> };
type Issue = Omit<RefundFinding, "kind"> & { id: string; kind: RefundFinding["kind"] | "Merchant-confirmed miss";
  outcome: (typeof pilotOutcomes)[number] | "missed"; revision: number; note: string };
type State = {
  files: Partial<Record<ExportSide, Source>>;
  baseline?: Stamp & { minutes: number | null; exceptions: string[] | null; beforeFindings: boolean };
  revealedAt?: string; issues: Issue[]; exact?: number;
  time: { review: number | null; setup: number | null; waiting: number | null };
  decision?: Stamp & { value: (typeof pilotDecisions)[number]; note: string };
};
type Scope = { id: string; location: string; register: string; week: string; end: string; timeZone: string; synthetic: number };
const fields = "id, location, register, week, end_date AS end, time_zone AS timeZone, synthetic";
type EventWriter = (employee: Employee, id: string, kind: HistoryKind, detail: string, at: string) => void;
type HistoryReader = (merchantId: string, id: string) => CaseHistory[];

export class PilotReviews {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string,
    private readonly event: EventWriter, private readonly history: HistoryReader) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_pilot_reviews (
        merchant_id TEXT NOT NULL, id TEXT NOT NULL, location TEXT NOT NULL, register TEXT NOT NULL,
        week TEXT NOT NULL, end_date TEXT NOT NULL, time_zone TEXT NOT NULL, synthetic INTEGER NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY (merchant_id, id), UNIQUE (merchant_id, location, register, week, time_zone, synthetic)
      );
      CREATE TABLE IF NOT EXISTS team_pilot_cases (
        merchant_id TEXT NOT NULL, pilot_id TEXT NOT NULL, case_id TEXT NOT NULL,
        PRIMARY KEY (merchant_id, case_id),
        FOREIGN KEY (merchant_id, pilot_id) REFERENCES team_pilot_reviews(merchant_id, id),
        FOREIGN KEY (merchant_id, case_id) REFERENCES team_cases(merchant_id, id)
      );
    `);
  }

  private open(employee: Employee, id: string) {
    const row = this.db.prepare(`SELECT ${fields}, state FROM team_pilot_reviews WHERE merchant_id=? AND id=?`)
      .get(employee.merchantId, id) as (Scope & { state: string }) | undefined;
    if (!row) throw new TeamError("PILOT_NOT_FOUND", 404);
    const { state, ...scope } = row;
    return { scope, state: JSON.parse(state) as State };
  }

  private start(employee: Employee, command: Extract<PilotCommand,{action:"startPilot"}>, syntheticOnly: boolean) {
    const { location, register, week, timeZone, synthetic } = command;
    if (syntheticOnly && !synthetic) throw new TeamError("PILOT_SYNTHETIC_ONLY", 403);
    let calendar: Intl.DateTimeFormat;
    try {
      calendar = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      throw new TeamError("PILOT_INVALID_WEEK", 422);
    }
    const zone = calendar.resolvedOptions().timeZone;
    if (!zone.includes("/") && zone !== "UTC") throw new TeamError("PILOT_INVALID_WEEK", 422);
    const end = addCashWeekDays(week, 6);
    if (end >= calendar.format(new Date(this.now()))) {
      throw new TeamError("PILOT_INVALID_WEEK", 422);
    }
    const existing = this.db.prepare(`SELECT id FROM team_pilot_reviews WHERE merchant_id=? AND location=? AND register=?
      AND week=? AND time_zone=? AND synthetic=?`).get(employee.merchantId, location, register, week, zone, Number(synthetic));
    if (existing) return this.open(employee, existing.id as string);
    const id = randomUUID();
    const state: State = { files: {}, issues: [], time: { review: null, setup: null, waiting: null } };
    this.db.prepare("INSERT INTO team_pilot_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(employee.merchantId, id, location, register, week, end, zone, Number(synthetic), JSON.stringify(state));
    return this.open(employee, id);
  }

  private project(employee: Employee, scope: Scope, state: State) {
    const sources = Object.entries(state.files).map(([side, {name,review}]) => ({
      side: side as ExportSide, name, rows: review.candidates, accepted: review.accepted.length, rejected: review.rejections,
    }));
    const count = (outcome: Issue["outcome"]) => state.issues.filter(issue => issue.outcome === outcome).length;
    const confirmed = count("confirmed");
    const incorrect = count("incorrect flag");
    const unresolved = count("unresolved");
    const missed = count("missed");
    const baseline = state.baseline ?? null;
    const comparable = state.revealedAt && baseline?.beforeFindings && baseline.minutes !== null && state.time.review !== null;
    return { scope, sources, baseline, revealedAt: state.revealedAt ?? null, comparisonReady: sources.length === 2,
      exact: state.exact ?? null, time: state.time, savedMinutes: comparable ? baseline.minutes! - state.time.review! : null,
      decision: state.decision ?? null,
      score: state.revealedAt ? { confirmed, incorrect, unresolved, missed, flags: confirmed + incorrect + unresolved,
        decided: confirmed + incorrect } : null,
      issues: state.issues.map(issue => ({ ...issue, history: this.history(employee.merchantId, issue.id) })) };
  }

  private newIssue(employee: Employee, pilotId: string, issue: Omit<Issue, "id" | "revision">, now: string) {
    const id = randomUUID();
    const ref = issue.rows[0]?.reference ?? "Merchant-confirmed issue";
    this.db.prepare(`INSERT INTO team_cases VALUES (?, ?, ?, 1, ?, ?, 'Investigating', ?, ?, ?)`)
      .run(employee.merchantId, id, ref, employee.username, employee.name, issue.explanation, "Review pilot evidence.", now);
    this.db.prepare("INSERT INTO team_pilot_cases VALUES (?, ?, ?)").run(employee.merchantId, pilotId, id);
    this.event(employee, id, issue.outcome === "missed" ? "Pilot missed issue" : "Opened", issue.explanation, now);
    return { ...issue, id, revision: 0 };
  }

  private attach(state: State, source: ExportSide, file: z.infer<typeof pilotFile>) {
    const key = createHash("sha256").update(file.text).update(JSON.stringify(file.mapping)).digest("hex");
    const prior = state.files[source];
    if (prior?.key === key) return;
    if (prior) throw new TeamError("PILOT_SOURCE_CHANGED", 409);
    const review = reviewRefundCsv(file.text, file.mapping, true);
    if (!review.accepted.length) throw new TeamError("CSV_NO_ACCEPTED_ROWS", 422);
    state.files[source] = { name: file.name, key, review };
  }

  private reveal(employee: Employee, scope: Scope, state: State, now: string) {
    if (state.revealedAt) return;
    const { Merchant, Processor } = state.files;
    if (!Merchant || !Processor) throw new TeamError("PILOT_NEEDS_BOTH", 409);
    const { findings, comparison } = compareReviewedRefunds(Merchant.review, Processor.review, {
      period: { start: scope.week, end: scope.end }, files: { Merchant: Merchant.name, Processor: Processor.name }, exact: []
    });
    state.revealedAt = now;
    state.exact = comparison.exact.length;
    state.issues = findings.map(finding => this.newIssue(employee, scope.id, { ...finding, outcome: "unresolved", note: "" }, now));
  }

  private decide(employee: Employee, state: State, command: Extract<PilotCommand,{action:"decidePilotIssue"}>, now: string) {
    const issue = state.issues.find(item => item.id === command.caseId && item.outcome !== "missed");
    if (!issue) throw new TeamError("PILOT_NOT_FOUND", 404);
    if (issue.outcome === command.outcome && issue.note === command.note && issue.revision > 0) return;
    if (issue.revision !== command.revision) throw new TeamError("PILOT_CASE_CHANGED", 409);
    issue.outcome = command.outcome;
    issue.note = command.note;
    issue.revision++;
    this.event(employee, issue.id, "Pilot disposition", issue.outcome + (issue.note ? " · " + issue.note : ""), now);
  }

  private miss(employee: Employee, scope: Scope, state: State, command: Extract<PilotCommand,{action:"addPilotMiss"}>, now: string) {
    if (!state.revealedAt) throw new TeamError("PILOT_NEEDS_BOTH", 409);
    const rows: EvidenceRow[] = Object.entries(state.files).flatMap(([side,{review}]) =>
      review.candidates.filter(row => row.reference === command.reference).map(row => ({ ...row, side: side as ExportSide })));
    if (!rows.length) throw new TeamError("PILOT_SOURCE_REFERENCE", 422);
    if (state.issues.some(issue => issue.outcome === "missed" && issue.rows[0]?.reference === command.reference && issue.note === command.note)) return;
    state.issues.push(this.newIssue(employee, scope.id, { kind: "Merchant-confirmed miss", rows, outcome: "missed",
      explanation: command.note, note: command.note }, now));
  }

  handle(employee: Employee, command: PilotCommand, syntheticOnly: boolean) {
    if (!canReview(employee.role)) throw new TeamError("PILOT_ROLE_REQUIRED", 403);
    if (syntheticOnly && (command.action === "inspectPilotCsv" || command.action === "attachPilotFile")) {
      throw new TeamError("PILOT_SYNTHETIC_ONLY", 403);
    }
    switch (command.action) {
      case "listPilots": return this.db.prepare(`SELECT ${fields} FROM team_pilot_reviews
        WHERE merchant_id=? AND (?=0 OR synthetic=1) ORDER BY week DESC, rowid DESC`).all(employee.merchantId, Number(syntheticOnly)) as unknown as Scope[];
      case "inspectPilotCsv": return inspectRefundCsv(command.text);
      case "startPilot": {
        const { scope, state } = this.start(employee, command, syntheticOnly);
        return this.project(employee, scope, state);
      }
    }
    const { scope, state } = this.open(employee, command.id);
    if (syntheticOnly && !scope.synthetic) throw new TeamError("PILOT_NOT_FOUND", 404);
    const now = this.now();
    const stamp = { actor: employee.name, at: now };
    switch (command.action) {
      case "openPilot": return this.project(employee, scope, state);
      case "attachPilotFile": this.attach(state, command.source, command.file); break;
      case "loadFictionalPilotFile":
        if (!syntheticOnly) throw new TeamError("PILOT_NOT_FOUND", 404);
        this.attach(state, command.source, fictionalPilotFile(command.source));
        break;
      case "savePilotBaseline":
        if (state.baseline) throw new TeamError("PILOT_BASELINE_RECORDED", 409);
        if (command.minutes === null && command.exceptions === null) throw new TeamError("PILOT_BASELINE_EMPTY", 422);
        state.baseline = { ...stamp, minutes: command.minutes, exceptions: command.exceptions, beforeFindings: !state.revealedAt };
        break;
      case "revealPilot": this.reveal(employee, scope, state, now); break;
      case "decidePilotIssue": this.decide(employee, state, command, now); break;
      case "addPilotMiss": this.miss(employee, scope, state, command, now); break;
      case "savePilotTime": state.time = { review: command.review, setup: command.setup, waiting: command.waiting }; break;
      case "savePilotDecision": state.decision = { ...stamp, value: command.decision, note: command.note }; break;
    }
    this.db.prepare("UPDATE team_pilot_reviews SET state=? WHERE merchant_id=? AND id=?")
      .run(JSON.stringify(state), employee.merchantId, scope.id);
    return this.project(employee, scope, state);
  }
}

export type PilotView = ReturnType<PilotReviews["project"]>;
export type PilotScope = PilotView["scope"];
