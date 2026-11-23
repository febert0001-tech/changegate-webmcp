import { teamWorkspace } from "../../../merchant-team/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({ error: "DEMO_ACCESS_UNAVAILABLE" }, {
  status: 404, headers: { "Cache-Control": "private, no-store" },
});

export function GET(request: Request) {
  return teamWorkspace()?.demoAccess?.read(request) ?? unavailable();
}

export function HEAD(request: Request) {
  const access = teamWorkspace()?.demoAccess;
  const denied = access ? 401 : 404;
  return new Response(null, {
    status: access?.session(request.headers) ? 204 : denied,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  return await teamWorkspace()?.demoAccess?.post(request) ?? unavailable();
}
