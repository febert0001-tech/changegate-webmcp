import { z } from "zod";

export function allowedPushEndpoint(endpoint: string) {
  try {
    const url=new URL(endpoint);
    return url.protocol==="https:" && !url.port && !url.username && !url.password && !url.hash &&
      (["fcm.googleapis.com","updates.push.services.mozilla.com","push.services.mozilla.com"].includes(url.hostname) ||
        url.hostname.endsWith(".push.apple.com") || url.hostname.endsWith(".notify.windows.com"));
  } catch { return false; }
}
export const alertEnrollment=z.strictObject({
  endpoint:z.string().max(2200).refine(allowedPushEndpoint),
  keys:z.strictObject({p256dh:z.string().regex(/^[A-Za-z0-9_-]{87}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{22}$/)}),
  duty:z.enum(["primary","backup"]),
  location:z.string().trim().max(100),
});
export type AlertEnrollment=z.infer<typeof alertEnrollment>;
export const alertEndpoint=z.string().max(2200).refine(allowedPushEndpoint);
export function alertPublicKey() {
  return process.env.CHANGEGATE_PUSH_PRIVATE_KEY && process.env.CHANGEGATE_PUSH_SUBJECT ?
    process.env.CHANGEGATE_PUSH_PUBLIC_KEY ?? null : null;
}
