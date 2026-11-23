import { notFound } from "next/navigation";
import { teamWorkspace } from "../../merchant-team/runtime";
import { DemoInviteEntry } from "../merchant/demo-invite-panel";

export const dynamic = "force-dynamic";

export default function InvitePage() {
  if (!teamWorkspace()?.demoAccess) notFound();
  return <DemoInviteEntry />;
}
