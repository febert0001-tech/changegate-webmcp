export const overnightReplayWeek = "2026-11-23";
export const overnightReplayLocation = "Harbor Fuel";

export function canReplayOvernight(user: { username: string; role?: string | undefined }) {
  return user.username === "jordan" && user.role === "manager";
}

export function overnightReplayHref(id: string) {
  return "/weekly-cash-review?replay=" + id;
}
