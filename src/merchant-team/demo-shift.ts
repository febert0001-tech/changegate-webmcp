import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { TeamError } from "./error";
import type { RefundTerms, TestSale } from "./refund-requests";
import accounts from "./demo-accounts.json" with { type: "json" };

export const demoMerchant = "harbor";
export const demoAccounts = accounts;

const fuel = { location: "Harbor Fuel", register: "Register 1" };
const bar = { location: "Harbor Bar", register: "Bar 1" };
const start = Date.parse("2026-11-22T18:00:00Z");
export const demoEscalationMs = 120_000;
export const demoReferencePrefix = "DEMO-SHIFT-";

export type DemoEvent = { title: string; at: string; sale?: TestSale; discountCents?: number;
  refund?: { cashier: string; amount: string; reason: string } };
export type DemoState = { runId: string; seed: string; step: number; event: DemoEvent; total: number;
  requestId?: string; finished: boolean };

export function generateDemoEvents(seed: string): DemoEvent[] {
  const digest = createHash("sha256").update(seed).digest();
  const reference = demoReferencePrefix + digest.toString("hex").slice(0, 16);
  const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
  const sale = (number: number, place: typeof fuel, originalCents: number): TestSale => ({
    ...place, reference: `${reference}-${number}`, originalCents, priorCents: 0, shift: "Demo shift", tender: "Electronic",
  });
  const refund = (number: number, minute: number, title: string, place: typeof fuel, cashier: string,
    amount: string, originalCents = 8000 + digest[number]!) => ({ title, at: at(minute), sale: sale(number, place, originalCents),
    refund: { cashier, amount, reason: "Generated shift refund" } });
  const discountCents = 3500 + digest[1]!;
  return [
    { title: "Ordinary sale", at: at(0), sale: sale(1, fuel, 2400 + digest[0]!) },
    { title: "Large discount", at: at(1), sale: sale(2, bar, 6000 - discountCents), discountCents },
    refund(3, 2, "Exact-$50 refund request", fuel, "maya", "50.00", 7500),
    refund(4, 4, "Unusual refund · cashier A at Harbor Fuel", fuel, "maya", "35.00"),
    refund(5, 6, "Unusual refund · cashier B at the same register", fuel, "qa-cashier-b", "36.00"),
    refund(6, 8, "Unusual refund · cashier A at Harbor Bar", bar, "maya", "37.00"),
    refund(7, 10, "Third unusual refund in both scopes", fuel, "maya", "38.00"),
    { title: "Advance the clock for backup escalation", at: at(13) },
  ];
}

type Run = { runId: string; seed: string; step: number };
export type ShiftSale = { reference: string; location: string; register: string; at: string;
  netCents: number; discountCents: number };

export class DemoShift {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS team_demo_shift (
      merchant_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seed TEXT NOT NULL, step INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_demo_shift_sales (
      merchant_id TEXT NOT NULL, run_id TEXT NOT NULL, step INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (merchant_id, run_id, step),
      FOREIGN KEY (merchant_id) REFERENCES team_demo_shift(merchant_id) ON DELETE CASCADE
    )`);
    // Earlier builds recorded only the seed and cursor. Backfill the sales already reached by that run.
    const previous = this.run();
    if (previous) {
      generateDemoEvents(previous.seed).slice(0, previous.step + 1)
        .forEach((event, step) => this.recordSale(previous.runId, step, event));
    }
  }

  includes(employee: Employee) { return employee.merchantId === demoMerchant; }

  private run(): Run | undefined {
    return this.db.prepare("SELECT run_id AS runId, seed, step FROM team_demo_shift WHERE merchant_id=?")
      .get(demoMerchant) as Run | undefined;
  }

  private request(reference: string) {
    return this.db.prepare("SELECT id FROM team_refund_requests WHERE merchant_id=? AND json_extract(terms,'$.reference')=?")
      .get(demoMerchant, reference)?.id as string | undefined;
  }

  private recordSale(runId: string, step: number, event: DemoEvent) {
    if (!event.sale || event.refund) return;
    const { reference, location, register, originalCents } = event.sale;
    const record: ShiftSale = { reference, location, register, at: event.at, netCents: originalCents,
      discountCents: event.discountCents ?? 0 };
    this.db.prepare("INSERT OR IGNORE INTO team_demo_shift_sales VALUES (?,?,?,?)")
      .run(demoMerchant, runId, step, JSON.stringify(record));
  }

  overviewRecords() {
    const run = this.run();
    if (!run) return null;
    const reached = generateDemoEvents(run.seed).slice(0, run.step + 1);
    const refundIds = reached.flatMap(event => {
      const id = event.sale && event.refund ? this.request(event.sale.reference) : undefined;
      return id ? [id] : [];
    });
    const rows = this.db.prepare("SELECT payload FROM team_demo_shift_sales WHERE merchant_id=? AND run_id=? ORDER BY step")
      .all(demoMerchant, run.runId);
    return { seed: run.seed, locations: [fuel.location, bar.location],
      sales: rows.map(row => JSON.parse(row.payload as string) as ShiftSale), refundIds };
  }

  state(): DemoState | null {
    const run = this.run();
    if (!run) return null;
    const events = generateDemoEvents(run.seed);
    const event = events[run.step]!;
    const requestId = event.refund && event.sale ? this.request(event.sale.reference) : undefined;
    return { ...run, event, ...(requestId && { requestId }), total: events.length, finished: run.step === events.length - 1 };
  }

  start(seed: string) {
    if (this.run()) throw new TeamError("DEMO_SHIFT_STARTED", 409);
    this.db.prepare("INSERT INTO team_demo_shift VALUES (?,?,?,0)").run(demoMerchant, randomUUID(), seed);
    const state = this.state()!;
    this.recordSale(state.runId, state.step, state.event);
    return state;
  }

  next(runId: string, step: number) {
    const state = this.state();
    if (!state || state.runId !== runId || state.step !== step || state.finished) throw new TeamError("DEMO_SHIFT_CHANGED", 409);
    if (state.event.refund && !state.requestId) throw new TeamError("DEMO_REFUND_REQUIRED", 409);
    this.db.prepare("UPDATE team_demo_shift SET step=step+1 WHERE merchant_id=?").run(demoMerchant);
    const next = this.state()!;
    this.recordSale(next.runId, next.step, next.event);
    return next;
  }

  replay(runId: string) {
    const run = this.run();
    if (!run || run.runId !== runId) throw new TeamError("DEMO_SHIFT_CHANGED", 409);
    const ids = generateDemoEvents(run.seed).flatMap(({ sale }) => sale ? this.request(sale.reference) ?? [] : []);
    for (const id of ids) {
      this.db.prepare("DELETE FROM team_refund_alert_sent WHERE merchant_id=? AND request_id=?").run(demoMerchant, id);
      this.db.prepare("DELETE FROM team_refund_alert_jobs WHERE merchant_id=? AND request_id=?").run(demoMerchant, id);
      this.db.prepare("DELETE FROM team_refund_watch WHERE merchant_id=? AND request_id=?").run(demoMerchant, id);
      this.db.prepare("DELETE FROM team_refund_request_events WHERE merchant_id=? AND request_id=?").run(demoMerchant, id);
      this.db.prepare("DELETE FROM team_refund_requests WHERE merchant_id=? AND id=?").run(demoMerchant, id);
    }
    this.db.prepare("DELETE FROM team_demo_shift WHERE merchant_id=?").run(demoMerchant);
    return this.start(run.seed);
  }

  find(employee: Employee, reference: string) {
    const run = this.includes(employee) && this.run();
    if (!run) return undefined;
    return generateDemoEvents(run.seed).slice(0, run.step + 1).find(({ sale }) => sale?.reference === reference)?.sale;
  }

  submission(employee: Employee, runId: string | undefined, terms: RefundTerms) {
    const state = this.state();
    const event = state?.event;
    if (!state || !event?.sale || !event.refund || state.runId !== runId || !this.includes(employee) ||
        employee.username !== event.refund.cashier || event.sale.reference !== terms.reference ||
        event.refund.amount !== terms.amount || event.refund.reason !== terms.reason ||
        (terms.source !== undefined && terms.source !== "test")) throw new TeamError("DEMO_SHIFT_CHANGED", 409);
    return { sale: event.sale, occurredAt: event.at, submissionId: this.submissionId(state) };
  }

  private submissionId(state: DemoState) {
    // One idempotency key per run/event, independent of the browser or retry.
    const digest = createHash("sha256").update(`${state.runId}:${state.step}`).digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  }
}
