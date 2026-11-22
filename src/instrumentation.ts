export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.CHANGEGATE_TEAM_MODE !== "staging") return;
  const { teamWorkspace } = await import("./merchant-team/runtime");
  const { startRefundAlerts } = await import("./merchant-team/refund-alert-worker");
  const workspace = teamWorkspace();
  if (workspace) startRefundAlerts(workspace.alerts,workspace.roster);
}
