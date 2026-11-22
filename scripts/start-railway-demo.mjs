import { mkdtempSync } from "node:fs";
import { join } from "node:path";

if (process.env.CHANGEGATE_TEAM_MODE !== "railway-demo" || process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    !process.env.RAILWAY_PUBLIC_DOMAIN || !process.env.CHANGEGATE_DEMO_ROSTER_JSON) {
  throw new Error("Railway demo requires a service domain, its demo roster, and ephemeral storage.");
}

process.env.CHANGEGATE_TEAM_DB = join(mkdtempSync("/tmp/changegate-demo-"), "synthetic-demo.sqlite");
await import("../server.js");
