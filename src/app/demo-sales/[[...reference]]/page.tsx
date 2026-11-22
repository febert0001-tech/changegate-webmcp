import { notFound } from "next/navigation";
import { demoSaleReference } from "../../../merchant-team/refund-requests";
import { MerchantConsole } from "../../merchant/merchant-console";

export default async function DemoSalePage({ params }: { params: Promise<{ reference?: string[] }> }) {
  const { reference = [] } = await params;
  if (reference.length > 1 || (reference[0] && !demoSaleReference.safeParse(reference[0]).success)) notFound();
  return <MerchantConsole demoSale={reference[0] ?? true} />;
}
