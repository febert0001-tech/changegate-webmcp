import { notFound } from "next/navigation";
import { teamWorkspace } from "../../merchant-team/runtime";
import { MerchantConsole } from "../merchant/merchant-console";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  if (!teamWorkspace()?.demoAccess) notFound();
  return <MerchantConsole inviteAdmin />;
}
