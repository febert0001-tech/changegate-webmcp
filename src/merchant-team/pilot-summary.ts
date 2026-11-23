import type { PilotView } from "./pilot-review";

function minutes(value: number | null | undefined) {
  return value == null ? "Unmeasured" : value + " min";
}

export function pilotSummaryText(view: PilotView) {
  const { scope, sources, score, baseline, time, decision } = view;
  const completeness = (side: "Merchant" | "Processor") => sources.some(source => source.side === side) ? "Present" : "Missing";
  return [
    "ChangeGate pilot summary",
    scope.synthetic ? "SYNTHETIC ACCEPTANCE RUN" : "Merchant pilot",
    "Reporting period: " + scope.week + " through " + scope.end,
    "Store time zone: " + scope.timeZone,
    "Register export: " + completeness("Merchant"),
    "Processor export: " + completeness("Processor"),
    "Confirmed ChangeGate flags: " + (score?.confirmed ?? "Unmeasured"),
    "Incorrect ChangeGate flags: " + (score?.incorrect ?? "Unmeasured"),
    "Unresolved ChangeGate flags: " + (score?.unresolved ?? "Unmeasured"),
    "Confirmed among decided ChangeGate flags: " + (score?.decided ? score.confirmed + " of " + score.decided : "Unmeasured"),
    "Merchant-confirmed misses recorded: " + (score?.missed ?? "Unmeasured"),
    "Usual process active review: " + minutes(baseline?.minutes),
    "ChangeGate active review: " + minutes(time.review),
    "ChangeGate setup: " + minutes(time.setup),
    "Waiting: " + minutes(time.waiting),
    "Owner decision: " + (decision?.value ?? "Undecided"),
    "",
  ].join("\n");
}
