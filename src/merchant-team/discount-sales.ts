import type { DatabaseSync } from "node:sqlite";
import { discountPolicy, type DiscountCommand, type DiscountSale } from "./discount-contracts";
import { demoRegister, type DemoSale } from "./demo-sales";
import type { Employee } from "./contracts";
import { TeamError } from "./error";
import { canReview, cents } from "./refund-requests";

export class DiscountSales {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS team_discount_sales (
      merchant_id TEXT NOT NULL, reference TEXT NOT NULL, cashier TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY (merchant_id, reference)
    )`);
  }

  recorded(merchant: string, reference: string) {
    const row = this.db.prepare("SELECT record FROM team_discount_sales WHERE merchant_id=? AND reference=?").get(merchant, reference);
    return row ? JSON.parse(String(row.record)) as DiscountSale : null;
  }

  command(employee: Employee, command: DiscountCommand, recordSale: (sale: DemoSale) => void) {
    const merchant = employee.merchantId;
    const manager = canReview(employee.role);
    const register = demoRegister(employee);
    if (!register && !manager) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    if (command.operation === "list") {
      const rows = manager
        ? this.db.prepare("SELECT record FROM team_discount_sales WHERE merchant_id=? ORDER BY rowid DESC").all(merchant)
        : this.db.prepare("SELECT record FROM team_discount_sales WHERE merchant_id=? AND cashier=? ORDER BY rowid DESC")
          .all(merchant, employee.username);
      return rows.map(row => JSON.parse(String(row.record)) as DiscountSale);
    }

    const { reference } = command;
    const row = this.db.prepare("SELECT cashier,record FROM team_discount_sales WHERE merchant_id=? AND reference=?")
      .get(merchant, reference);
    const owns = row?.cashier === employee.username;
    if (row && !owns && !manager) throw new TeamError("TRANSACTION_NOT_FOUND", 404);
    const current = row ? JSON.parse(String(row.record)) as DiscountSale : null;
    if (command.operation === "open") return current;
    const actor = { actor: employee.name, at: this.now() };

    if (command.operation === "start") {
      if (!register) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
      const proposal = { ...actor, ...discountTerms(command) };
      if (proposal.discountCents < discountPolicy.minimumCents) throw new TeamError("DISCOUNT_BELOW_DEMO_LIMIT", 400);
      if (current) {
        const first = current.proposals[0]!;
        if (!owns || first.originalCents !== proposal.originalCents || first.discountCents !== proposal.discountCents)
          throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
        return current;
      }
      const sale: DiscountSale = { reference, cashier: employee.name, proposals: [proposal] };
      this.db.prepare("INSERT INTO team_discount_sales VALUES (?,?,?,?)")
        .run(merchant, reference, employee.username, JSON.stringify(sale));
      return sale;
    }

    if (!current) throw new TeamError("TRANSACTION_NOT_FOUND", 404);
    const latest = current.proposals.at(-1)!;
    if (command.revision !== current.proposals.length) throw new TeamError("DISCOUNT_TERMS_CHANGED", 409);
    if (command.operation === "decide" ? !manager || owns : !register || !owns)
      throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
    if (current.completion) {
      if (command.operation === "finish" && command.choice === current.completion.choice) {
        if (command.choice !== "cancel" && (command.tender ?? "Electronic") !== (current.completion.tender ?? "Electronic"))
          throw new TeamError("TRANSACTION_SUBMISSION_CHANGED", 409);
        return current;
      }
      throw new TeamError("TRANSACTION_ACTION_UNAVAILABLE", 409);
    }
    switch (command.operation) {
      case "revise": {
        const terms = discountTerms(command);
        if (terms.originalCents !== latest.originalCents || terms.discountCents !== latest.discountCents)
          current.proposals.push({ ...actor, ...terms });
        break;
      }
      case "decide":
        if (latest.decision) throw new TeamError("TRANSACTION_DECIDED", 409);
        latest.decision = { ...actor, result: command.decision };
        break;
      case "finish": {
        if (!latest.decision || (command.choice === "discounted") !== (latest.decision.result === "Approved"))
          throw new TeamError("DISCOUNT_DECISION_REQUIRED", 409);
        const appliedCents = command.choice === "discounted" ? latest.discountCents : 0;
        const subtotalCents = command.choice === "cancel" ? null : latest.originalCents - appliedCents;
        const tender = command.tender ?? "Electronic";
        current.completion = { ...actor, choice: command.choice, subtotalCents, ...(subtotalCents !== null && { tender }) };
        if (subtotalCents !== null) recordSale({ reference, cashier: employee.name, recordedDemo: true, recordedAt: actor.at,
          originalCents: subtotalCents, discountCents: appliedCents, location: discountPolicy.location,
          register: discountPolicy.register, shift: "Manual demo", tender, priorCents: 0 });
        break;
      }
    }
    this.db.prepare("UPDATE team_discount_sales SET record=? WHERE merchant_id=? AND reference=?")
      .run(JSON.stringify(current), merchant, reference);
    return current;
  }
}

function discountTerms(command: { original: string; discount: string }) {
  const originalCents = cents(command.original);
  const discountCents = cents(command.discount);
  if (discountCents >= originalCents) throw new TeamError("DISCOUNT_INVALID", 400);
  return { originalCents, discountCents };
}
