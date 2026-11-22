import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Employee } from "./contracts";
import { demoMerchant } from "./demo-shift";
import { TeamError } from "./error";
import type { TestSale } from "./refund-requests";

export type DemoSale = TestSale & { recordedDemo: true; cashier: string; recordedAt: string };
const register = { location: "Harbor Fuel", register: "Register 1" };

export function demoRegister(employee: Employee) {
  return employee.merchantId === demoMerchant && employee.role === "cashier" &&
    (employee.username === "maya" || employee.username === "qa-cashier-b") ? register : undefined;
}

export class DemoSales {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS team_demo_sales (
      merchant_id TEXT NOT NULL, reference TEXT NOT NULL, cashier TEXT NOT NULL,
      submission_id TEXT NOT NULL, sale TEXT NOT NULL,
      PRIMARY KEY (merchant_id, reference), UNIQUE (merchant_id, cashier, submission_id)
    )`);
  }

  record(employee: Employee, submissionId: string, originalCents: number, tender: DemoSale["tender"]): DemoSale {
    const assignment = demoRegister(employee);
    if (!assignment) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    const existing = this.db.prepare("SELECT sale FROM team_demo_sales WHERE merchant_id=? AND cashier=? AND submission_id=?")
      .get(employee.merchantId, employee.username, submissionId);
    if (existing) {
      const sale = JSON.parse(existing.sale as string) as DemoSale;
      if (sale.originalCents !== originalCents || sale.tender !== tender) throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
      return sale;
    }
    const sale: DemoSale = { ...assignment, reference: "DEMO-SALE-" + randomUUID(), shift: "Manual demo",
      originalCents, priorCents: 0, tender, recordedDemo: true, cashier: employee.name, recordedAt: this.now() };
    this.db.prepare("INSERT INTO team_demo_sales VALUES (?,?,?,?,?)")
      .run(employee.merchantId, sale.reference, employee.username, submissionId, JSON.stringify(sale));
    return sale;
  }

  open(employee: Employee, reference: string): DemoSale {
    const row = this.db.prepare("SELECT sale FROM team_demo_sales WHERE merchant_id=? AND reference=?")
      .get(employee.merchantId, reference);
    if (!row) throw new TeamError("TRANSACTION_NOT_FOUND", 404);
    return JSON.parse(row.sale as string) as DemoSale;
  }

  list(employee: Employee): DemoSale[] {
    return this.db.prepare("SELECT sale FROM team_demo_sales WHERE merchant_id=? ORDER BY rowid DESC")
      .all(employee.merchantId).map(row => JSON.parse(row.sale as string) as DemoSale);
  }
}
