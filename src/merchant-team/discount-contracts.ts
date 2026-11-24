import { z } from "zod";
import { demoSaleReference, usdAmount } from "./refund-requests";

const revision = z.number().int().positive();
const terms = { original: usdAmount, discount: usdAmount };
export const discountCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("open"), reference: demoSaleReference }),
  z.strictObject({ operation: z.literal("start"), reference: demoSaleReference, ...terms }),
  z.strictObject({ operation: z.literal("revise"), reference: demoSaleReference, revision, ...terms }),
  z.strictObject({ operation: z.literal("decide"), reference: demoSaleReference, revision,
    decision: z.enum(["Approved", "Rejected"]), password: z.string().min(1).max(160) }),
  z.strictObject({ operation: z.literal("finish"), reference: demoSaleReference, revision,
    choice: z.enum(["discounted", "full price", "cancel"]) }),
]);

export type DiscountCommand = z.infer<typeof discountCommand>;
export const discountPolicy = { minimumCents: 2500, location: "Harbor Bar", register: "Bar 1" };

type Actor = { actor: string; at: string };
type Proposal = Actor & { originalCents: number; discountCents: number; decision?: Actor & { result: "Approved" | "Rejected" } };
export type DiscountSale = {
  reference: string;
  cashier: string;
  proposals: Proposal[];
  completion?: Actor & { choice: "discounted" | "full price" | "cancel"; subtotalCents: number | null };
};
