import { Suspense } from "react";
import { MerchantConsole } from "../merchant/merchant-console";

export default function ShiftOverviewPage() {
  return <Suspense fallback={<p role="status">Loading Shift Overview…</p>}><MerchantConsole overview /></Suspense>;
}
