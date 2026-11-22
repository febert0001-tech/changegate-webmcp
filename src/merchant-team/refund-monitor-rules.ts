export const watchWindowMs = 15 * 60_000;
export const ruleVersion = "staging-refund-monitor-v1";
export const individualLimitCents = 10_000;

export function assessSize(amount: number, history?: { median: number; mad: number; floor: number }) {
  const z = history ? (amount - history.median) / Math.max(1.4826 * history.mad, history.floor) : null;
  return {
    z, absoluteHold: amount >= individualLimitCents,
    relativeHold: z !== null && z >= 4,
    watch: z !== null && z >= 2 && z < 4,
  };
}
