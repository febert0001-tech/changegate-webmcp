import { notFound } from "next/navigation";
import { z } from "zod";
import { MerchantConsole } from "../merchant/merchant-console";

export const dynamic = "force-dynamic";

export default async function CashDrawerPage({ searchParams }: {
  searchParams: Promise<{ id?: string | string[]; register?: string | string[]; example?: string | string[] }>;
}) {
  const { id, register, example } = await searchParams;
  if (example === "harbor-bar") return <MerchantConsole cashDrawer cashDrawerExample />;
  if (id !== undefined && !z.uuid().safeParse(id).success) notFound();
  return <MerchantConsole cashDrawer={typeof id === "string" ? id : true}
    {...(register === "harbor-bar" && { cashDrawerRegister: register })} />;
}
