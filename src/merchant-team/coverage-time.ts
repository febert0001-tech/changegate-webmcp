import { cashTimeZone } from "./weekly-cash-review";

export const coverageUpdated = "changegate-coverage-updated";
export const coverageTimeZone = cashTimeZone;
export const coveragePermissions = ["Review drawer discrepancies", "Request owner follow-up"] as const;
export type CoverageGrant = {
  id: string; location: string; reviewer: string; reviewerName: string;
  startsAt: string; endsAt: string; grantedBy: string; grantedAt: string;
  revokedBy: string | null; revokedAt: string | null;
  status: "Scheduled" | "Active" | "Ended" | "Revoked";
};

const localMinute = new Intl.DateTimeFormat("en-CA", {
  timeZone: coverageTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const display = new Intl.DateTimeFormat("en-US", {
  timeZone: coverageTimeZone, dateStyle: "medium", timeStyle: "short",
});

export const coverageDateTime = (instant: string) => display.format(new Date(instant)) + " Eastern";

export function coverageInstant(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const wall = Date.parse(local + "Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) return null;
  const matches = new Set<string>();
  // Try offsets on both sides of a potential clock change and reject an ambiguous or skipped minute.
  for (const day of [-1, 0, 1]) {
    const sample = wall + day * 86_400_000;
    const values = Object.fromEntries(localMinute.formatToParts(sample).map(({ type, value }) => [type, value]));
    const showing = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}Z`);
    const instant = wall - (showing - sample);
    const parts = Object.fromEntries(localMinute.formatToParts(instant).map(({ type, value }) => [type, value]));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === local) {
      matches.add(new Date(instant).toISOString());
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}
