import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { teamWorkspace } from "../../merchant-team/runtime";
import { DemoGuestWalkthrough } from "../merchant/demo-invite-panel";

export const dynamic = "force-dynamic";

export default async function GuestPage() {
  if (!teamWorkspace()?.demoAccess?.session(await headers())) notFound();
  return <DemoGuestWalkthrough />;
}
