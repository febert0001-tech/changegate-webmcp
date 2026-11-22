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


type ClosedWindow = { endedAt: string; salesAndRefunds: number; refunds: number };
export function observeRefundShare(history: number[], baseline: number, priorWeight: number, minimum: number, windows: ClosedWindow[]) {
  if (!history.length) return [];
  const ordered=[...history].sort((a,b)=>a-b);
  const percentile=ordered[Math.ceil(ordered.length*0.99)-1]!;
  let ewma=baseline, streak=0;
  return windows.map(window=>{
    const eligible=window.salesAndRefunds>=minimum;
    if (eligible) {
      const share=(window.refunds+priorWeight*baseline)/(window.salesAndRefunds+priorWeight);
      ewma=0.25*share+0.75*ewma;
      streak=ewma>percentile?streak+1:0;
    }
    return { ...window, eligible, ewma, percentile, elevated:streak>=2 };
  });
}

// Fixed completed staging fixtures, never estimates for a connected store.
export function syntheticRegisterDrift(reference: string) {
  if(!/^TEST-MONITOR-[123]$/.test(reference))return null;
  return {source:"Synthetic completed windows", observationOnly:true,
    windows:observeRefundShare([.045,.05,.055,.06],.05,20,10,[
      {endedAt:"2026-11-20T14:15:00Z",salesAndRefunds:60,refunds:14},
      {endedAt:"2026-11-20T14:30:00Z",salesAndRefunds:55,refunds:13},
    ]),
  };
}
