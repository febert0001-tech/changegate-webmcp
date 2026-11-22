import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareRefunds, comparisonInput } from "./refund-comparison";

const mapping = { reference: 0, amount: 1, currency: 2, status: 3 };
const file = (name: string) => ({ name, mapping, text: readFileSync("tests/fixtures/" + name, "utf8") });
const input = {
  merchant: file("TEST-only-merchant-register.csv"),
  processor: file("TEST-only-processor-export.csv"),
  period: { start: "2026-11-01", end: "2026-11-07" },
};

describe("paired refund exports", () => {
  it("accounts for exact matches, both missing sides, cent differences, and ambiguous candidates", () => {
    const result = compareRefunds(comparisonInput.parse(input));
    expect(result.accepted).toHaveLength(10);
    expect(result.rejections).toEqual([expect.objectContaining({ side: "Merchant", line: 7 })]);
    expect(result.comparison.exact).toEqual([[expect.objectContaining({ side: "Merchant", amountCents: 1020 }),
      expect.objectContaining({ side: "Processor", amountCents: 1020 })]]);
    expect(result.findings).toHaveLength(5);
    expect(result.findings.find(row => row.kind === "Amount difference")).toMatchObject({
      differenceCents: 1800,
      rows: [{ side: "Merchant", amountCents: 4200, line: 2 }, { side: "Processor", amountCents: 2400, line: 2 }],
    });
    for (const kind of ["Merchant only", "Processor only"]) {
      expect(result.findings.find(row => row.kind === kind)?.explanation).toContain("Its payment outcome is unverified.");
    }
    const ambiguous = result.findings.filter(row => row.kind === "Ambiguous reference");
    expect(ambiguous.map(row => row.rows.length)).toEqual([3, 2]);
    expect(ambiguous[1]?.rows[0]).toMatchObject({ side: "Merchant", amountCents: null, rejected: true });
  });

  it("validates the shared period", () => {
    expect(comparisonInput.safeParse({ ...input, period: { start: "2026-11-08", end: "2026-11-07" } }).success).toBe(false);
  });
});
