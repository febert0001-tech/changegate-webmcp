import { notFound } from "next/navigation";
import { z } from "zod";
import { MerchantConsole } from "../merchant/merchant-console";

export const dynamic = "force-dynamic";

export default async function CashDrawerPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const { id } = await searchParams;
  if (id !== undefined && !z.uuid().safeParse(id).success) notFound();
  return <MerchantConsole cashDrawer={typeof id === "string" ? id : true} />;
}
