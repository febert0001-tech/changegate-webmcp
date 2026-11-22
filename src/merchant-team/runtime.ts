import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { rosterSchema } from "./contracts";
import { createTeamWorkspace } from "./handler";
import { configuredSquareSandbox } from "./square-sandbox";
import { configuredPayPalSandbox } from "./paypal-provider";
import { TeamStore } from "./store";
import { demoAccounts } from "./demo-shift";

let workspace: ReturnType<typeof createTeamWorkspace> | undefined;

export function teamWorkspace() {
  if (workspace) return workspace;
  try {
    const env = process.env;
    const staging = env.CHANGEGATE_TEAM_MODE === "staging";
    const hostedDemo = env.CHANGEGATE_TEAM_MODE === "railway-demo";
    const demo = hostedDemo || env.CHANGEGATE_TEAM_MODE === "demo";
    if (env.CHANGEGATE_TEAM_MODE && !staging && !demo) return undefined;
    const origin = hostedDemo ? `https://${env.RAILWAY_PUBLIC_DOMAIN ?? ""}` :
      env.CHANGEGATE_TEAM_ORIGIN ?? (staging ? "" : "http://127.0.0.1:3190");
    let db: string;
    let config: unknown;
    if (staging || hostedDemo) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.port || !url.hostname.endsWith(".up.railway.app")) {
        return undefined;
      }
      if (hostedDemo) {
        const path = env.CHANGEGATE_TEAM_DB ?? "";
        const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
        const volumeReady = mount === "/demo-data" && path === "/demo-data/changegate/synthetic-demo.sqlite" &&
          readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(line => line.split(" ")[4] === mount);
        if (!volumeReady) return undefined;
        db = path;
        config = JSON.parse(env.CHANGEGATE_DEMO_ROSTER_JSON ?? "") as unknown;
      } else {
        if (env.RAILWAY_VOLUME_MOUNT_PATH !== "/data" ||
            !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => line.split(" ")[4] === "/data")) return undefined;
        db = join("/data", "merchant.sqlite");
        const current = rosterSchema.parse(JSON.parse(env.CHANGEGATE_TEAM_ROSTER_JSON ?? "") as unknown);
        const acceptance = env.CHANGEGATE_TEAM_ACCEPTANCE_ROSTER_JSON;
        config = acceptance ? [...current, ...rosterSchema.parse(JSON.parse(acceptance) as unknown)] : current;
      }
    } else {
      const localDb = env.CHANGEGATE_TEAM_DB;
      const users = env.CHANGEGATE_TEAM_USERS_FILE;
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) || !localDb || !users ||
          !isAbsolute(localDb) || !isAbsolute(users) || localDb === users) return undefined;
      if (demo && basename(localDb) !== "synthetic-demo.sqlite") return undefined;
      db = localDb;
      config = JSON.parse(readFileSync(users, "utf8"));
    }

    const roster = rosterSchema.parse(config);
    if (demo && (roster.length !== demoAccounts.length || !demoAccounts.every(account => roster.some(member =>
      member.username === account.username && member.role === account.role && member.merchantId === account.merchantId &&
      member.merchantName === account.merchantName)))) return undefined;
    const store = new TeamStore(db, undefined, demo);
    try {
      const square = demo ? undefined : configuredSquareSandbox();
      const paypal = demo ? undefined : configuredPayPalSandbox();
      return workspace = createTeamWorkspace(store, roster, origin, {
        staging: staging || hostedDemo, hostedDemo, ...(square && { square }), ...(paypal && { paypal }),
      });
    } catch (error) {
      store.close();
      throw error;
    }
  } catch {
    return undefined;
  }
}
