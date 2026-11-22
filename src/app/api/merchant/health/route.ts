import { teamWorkspace } from "../../../../merchant-team/runtime";

export const runtime = "nodejs";

export function GET() {
  const ready = Boolean(teamWorkspace());
  return new Response(ready ? "ready" : "unavailable", {
    status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" },
  });
}
