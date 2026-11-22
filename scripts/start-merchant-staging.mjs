import { chmodSync, chownSync, readFileSync } from "node:fs";

const mount = "/data";
const mounted = readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n").some((line) => line.split(" ")[4] === mount);
if (process.env.CHANGEGATE_TEAM_MODE !== "staging" ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH !== mount || !mounted) {
  throw new Error("Staging requires its mounted Railway volume at /data.");
}

if (process.getuid() === 0) {
  // Railway mounts a new volume as root. The application itself runs as the image's node user.
  chownSync(mount, 1000, 1000);
  chmodSync(mount, 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
await import("../server.js");
