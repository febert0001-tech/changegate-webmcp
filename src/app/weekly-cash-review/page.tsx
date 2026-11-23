import { z } from "zod";
import { MerchantConsole } from "../merchant/merchant-console";

export default async function WeeklyCashReviewPage({ searchParams }: {
  searchParams: Promise<{ week?: string | string[]; location?: string | string[] }>;
}) {
  const { week, location } = await searchParams;
  return <MerchantConsole cashWeek={{ ...(typeof week === "string" && z.iso.date().safeParse(week).success && { week }),
    ...(typeof location === "string" && location.trim() && location.length <= 120 && { location }) }} />;
}
