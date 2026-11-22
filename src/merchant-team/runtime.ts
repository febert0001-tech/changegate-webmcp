import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { rosterSchema } from "./contracts";
import { createTeamWorkspace } from "./handler";
import { TeamStore } from "./store";

let workspace: ReturnType<typeof createTeamWorkspace> | undefined;

export function teamWorkspace() {
  if (workspace) return workspace;
  const origin = process.env.CHANGEGATE_TEAM_ORIGIN ?? "http://127.0.0.1:3190";
  const db = process.env.CHANGEGATE_TEAM_DB;
  const users = process.env.CHANGEGATE_TEAM_USERS_FILE;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) || !db || !users ||
      !isAbsolute(db) || !isAbsolute(users) || db === users) return undefined;
  try {
    const config: unknown = JSON.parse(readFileSync(users, "utf8"));
    const roster = rosterSchema.parse(config);
    const store = new TeamStore(db);
    try {
      return workspace = createTeamWorkspace(store, roster, origin);
    } catch (error) {
      store.close();
      throw error;
    }
  } catch {
    return undefined;
  }
}
