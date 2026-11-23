import { chmodSync, chownSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (process.env.CHANGEGATE_TEAM_MODE !== "railway-demo" || mount !== "/demo-data" ||
    !process.env.RAILWAY_PUBLIC_DOMAIN || !process.env.CHANGEGATE_DEMO_ROSTER_JSON) {
  throw new Error("Railway demo requires its service domain, roster and designated synthetic data path.");
}

const data = join(mount, "changegate");
mkdirSync(data, { recursive: true, mode: 0o700 });
if (!lstatSync(data).isDirectory()) throw new Error("Expected a synthetic data directory.");
if (process.getuid() === 0) {
  chownSync(data, 1000, 1000);
  chmodSync(data, 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
process.env.CHANGEGATE_TEAM_DB = join(data, "synthetic-demo.sqlite");
await import("../server.js");
