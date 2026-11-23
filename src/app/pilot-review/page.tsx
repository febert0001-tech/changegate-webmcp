import { Suspense } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MerchantConsole } from "../merchant/merchant-console";

export default async function PilotPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const { id } = await searchParams;
  if (id !== undefined && !z.uuid().safeParse(id).success) notFound();
  return <Suspense fallback={<p role="status">Loading pilot workspace…</p>}>
    <MerchantConsole pilot={typeof id === "string" ? id : true} />
  </Suspense>;
}
