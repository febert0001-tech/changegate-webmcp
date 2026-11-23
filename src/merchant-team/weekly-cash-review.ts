import type { CaseStatus } from "./contracts";

export const cashTimeZone = "America/New_York";
export const drawerDispositions = ["Recount corrected the count", "Difference explained", "Closed with difference unexplained"] as const;
export type DrawerDisposition = typeof drawerDispositions[number];
type Count = { cents: number; actor: string; at: string };

export type CashWeekRow = {
  id: string;
  location: string;
  register: string;
  openedAt: string;
  close: { expected: number; variance: number; firstCount: Count; recount: (Count & { note: string }) | null;
    review: { id: string; status: CaseStatus; reviewer: string | null; disposition: DrawerDisposition | null } | null } | null;
};

export type CashWeek = { start: string; end: string; timeZone: string; locations: string[]; rows: CashWeekRow[] };

const storeCalendar = new Intl.DateTimeFormat("en-CA", { timeZone: cashTimeZone,
  year: "numeric", month: "2-digit", day: "2-digit" });
export const cashStoreDate = (instant: string) => storeCalendar.format(new Date(instant));

export function addCashWeekDays(date: string, days: number) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function cashWeekMonday(date: string) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  return addCashWeekDays(date, -((day + 6) % 7));
}

export function cashWeekGroups(rows: CashWeekRow[]) {
  return {
    completed: rows.filter(row => row.close),
    short: rows.filter(row => row.close && row.close.variance < 0),
    over: rows.filter(row => row.close && row.close.variance > 0),
    balanced: rows.filter(row => row.close?.variance === 0),
    unresolved: rows.filter(row => row.close?.review && row.close.review.status !== "Resolved"),
    incomplete: rows.filter(row => !row.close),
  };
}

export const originalVarianceTotal = (rows: CashWeekRow[]) =>
  rows.reduce((sum, row) => sum + Math.abs(row.close?.variance ?? 0), 0);
