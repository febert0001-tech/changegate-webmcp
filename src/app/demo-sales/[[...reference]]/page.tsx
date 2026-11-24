import { notFound } from "next/navigation";
import { demoSaleReference } from "../../../merchant-team/refund-requests";
import { MerchantConsole } from "../../merchant/merchant-console";

export default async function DemoSalePage({ params, searchParams }: {
  params: Promise<{ reference?: string[] }>; searchParams: Promise<{ discount?: string }>;
}) {
  const { reference = [] } = await params;
  if (reference.length > 1 || (reference[0] && !demoSaleReference.safeParse(reference[0]).success)) notFound();
  return <MerchantConsole demoSale={reference[0] ?? true} discountSale={(await searchParams).discount === "1"} />;
}
