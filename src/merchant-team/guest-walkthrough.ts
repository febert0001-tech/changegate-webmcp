// Curated demonstration records. This module is reachable only through the server guest API.
export const guestWalkthrough = [
  { title: "Held refund · Harbor Fuel", facts: [
    "Maya requested a synthetic $38.00 refund.",
    "The request reached the third unusual refund within 15 minutes at the same register and across registers for the same cashier.",
    "ChangeGate held the request for separate supervisor approval. Confirmed payout was $0.00.",
  ] },
  { title: "Recorded Square Sandbox result", facts: [
    "Original sale: $75.00. Square reported zero refunds during the hold.",
    "Jordan approved $52.00. Square independently confirmed one completed $52.00 sandbox refund after restart.",
    "$23.00 remained refundable. Verified November 22, 2026 at 7:36:13 p.m. Eastern.",
  ] },
  { title: "Synthetic pilot scorecard", facts: [
    "Three ChangeGate flags: one confirmed, one incorrect, and one unresolved.",
    "1 of 2 confirmed among decided flags. The merchant reviewer recorded one missed issue.",
    "Synthetic time example: 24 usual-process active minutes, 12 ChangeGate active minutes, 5 setup minutes and 30 waiting minutes. Merchant time savings remain unmeasured.",
  ] },
] as const;
