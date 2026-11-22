import { teamWorkspace } from "../../../merchant-team/runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const workspace = teamWorkspace();
  return workspace ? workspace.handle(request) : Response.json({ error: "WORKSPACE_NOT_CONFIGURED" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}
