import { Suspense } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MerchantConsole } from "../merchant/merchant-console";

export default async function OvernightPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const { id } = await searchParams;
  if (id !== undefined && !z.uuid().safeParse(id).success) notFound();
  return <Suspense fallback={<p role="status">Loading review desk…</p>}>
    <MerchantConsole overnight={typeof id === "string" ? id : true} />
  </Suspense>;
}

