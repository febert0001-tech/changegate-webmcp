import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { rosterSchema } from "./contracts";
import { createTeamWorkspace } from "./handler";
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
      config = JSON.parse(env.CHANGEGATE_TEAM_ROSTER_JSON ?? "");
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
      return workspace = createTeamWorkspace(store, roster, origin, { staging });
    } catch (error) {
      store.close();
      throw error;
    }
  } catch {
    return undefined;
  }
}
