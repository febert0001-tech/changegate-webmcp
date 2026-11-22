import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rosterSchema } from "./contracts";
import { createTeamWorkspace } from "./handler";
import { configuredSquareSandbox } from "./square-sandbox";
import { TeamStore } from "./store";

let workspace: ReturnType<typeof createTeamWorkspace> | undefined;

export function teamWorkspace() {
  if (workspace) return workspace;
  try {
    const env = process.env;
    const staging = env.CHANGEGATE_TEAM_MODE === "staging";
    if (env.CHANGEGATE_TEAM_MODE && !staging) return undefined;
    const origin = env.CHANGEGATE_TEAM_ORIGIN ?? (staging ? "" : "http://127.0.0.1:3190");
    let db: string;
    let config: unknown;
    if (staging) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.port || !url.hostname.endsWith(".up.railway.app") ||
          env.RAILWAY_VOLUME_MOUNT_PATH !== "/data" ||
          !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => line.split(" ")[4] === "/data")) {
        return undefined;
      }
      db = join("/data", "merchant.sqlite");
      const current = rosterSchema.parse(JSON.parse(env.CHANGEGATE_TEAM_ROSTER_JSON ?? "") as unknown);
      const acceptance = env.CHANGEGATE_TEAM_ACCEPTANCE_ROSTER_JSON;
      config = acceptance ? [...current, ...rosterSchema.parse(JSON.parse(acceptance) as unknown)] : current;
    } else {
      const localDb = env.CHANGEGATE_TEAM_DB;
      const users = env.CHANGEGATE_TEAM_USERS_FILE;
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) || !localDb || !users ||
          !isAbsolute(localDb) || !isAbsolute(users) || localDb === users) return undefined;
      db = localDb;
      config = JSON.parse(readFileSync(users, "utf8"));
    }

    const roster = rosterSchema.parse(config);
    const store = new TeamStore(db);
    try {
      const square = configuredSquareSandbox();
      return workspace = createTeamWorkspace(store, roster, origin, { staging, ...(square && { square }) });
    } catch (error) {
      store.close();
      throw error;
    }
  } catch {
    return undefined;
  }
}
