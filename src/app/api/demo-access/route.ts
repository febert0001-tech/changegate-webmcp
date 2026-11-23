import { teamWorkspace } from "../../../merchant-team/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({ error: "DEMO_ACCESS_UNAVAILABLE" }, {
  status: 404, headers: { "Cache-Control": "private, no-store" },
});

export function GET(request: Request) {
  return teamWorkspace()?.demoAccess?.read(request) ?? unavailable();
}

export async function POST(request: Request) {
  return await teamWorkspace()?.demoAccess?.post(request) ?? unavailable();
}
