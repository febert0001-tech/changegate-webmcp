import type { ExportSide } from "./refund-csv";

const header = "refund_reference,refund_amount,currency,status";
const mapping = { reference: 0, amount: 1, currency: 2, status: 3 };
const files = {
  Merchant: [header, "DEMO-AMOUNT,15,USD,COMPLETED", "DEMO-TIMING,20,USD,COMPLETED",
    "DEMO-STATUS,8,USD,PENDING", "DEMO-OPEN,25,USD,COMPLETED", ",5,USD,COMPLETED"],
  Processor: [header, "DEMO-AMOUNT,17,USD,COMPLETED", "DEMO-STATUS,8,USD,COMPLETED", "DEMO-OPEN,22,USD,COMPLETED"],
};

export function fictionalPilotFile(side: ExportSide) {
  return { name: side === "Merchant" ? "fictional-register.csv" : "fictional-processor.csv",
    text: files[side].join("\n"), mapping };
}
