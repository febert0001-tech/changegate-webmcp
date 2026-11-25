import { z } from "zod";
import { notFound } from "next/navigation";
import { MerchantConsole } from "../merchant/merchant-console";

export default async function WeeklyCashReviewPage({ searchParams }: {
  searchParams: Promise<{ week?: string | string[]; location?: string | string[]; replay?: string | string[] }>;
}) {
  const { week, location, replay } = await searchParams;
  if (replay !== undefined && !z.uuid().safeParse(replay).success) notFound();
  return <MerchantConsole cashWeek={{ ...(typeof replay === "string" && { replay }),
    ...(typeof week === "string" && z.iso.date().safeParse(week).success && { week }),
    ...(typeof location === "string" && location.trim() && location.length <= 120 && { location }) }} />;
}
