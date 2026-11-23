import { z } from "zod";
import type { Employee } from "./contracts";
import type { DemoInvites } from "./demo-invites";
import { TeamError } from "./error";
import { guestWalkthrough } from "./guest-walkthrough";

type Incoming = Pick<Headers, "get">;
const recipient = z.string().trim().min(1).max(100);
const minutes = z.number().int().min(30).max(60);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const command = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("plan"), recipient, minutes }),
  z.strictObject({ action: z.literal("issue"), id: z.uuid(), recipient, minutes, startsAt: z.number().int().positive() }),
  z.strictObject({ action: z.literal("revoke"), id: z.uuid() }),
  z.strictObject({ action: z.literal("redeem"), recipient, token: opaque, code: z.string().regex(/^[A-Za-z0-9_-]{24}$/) }),
]);
const json = (value: unknown, status = 200, cookie?: string) => Response.json(value, { status, headers: {
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  ...(cookie && { "Set-Cookie": cookie }),
}});
const error = (code: string, status: number) => json({ error: code }, status);

export function canManageDemoInvites(employee?: Employee) {
  return employee?.merchantId === "harbor" && employee.username === "jordan" && employee.role === "manager";
}

async function readGuestCommand(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > 2048) { void reader.cancel().catch(() => {}); return null; }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { return null; }
}

export function createDemoAccess(invites: DemoInvites, origin: string, secure: boolean,
  validIngress: (headers: Incoming) => boolean, employeeFor: (headers: Incoming) => Employee | undefined) {
  const name = secure ? "__Host-changegate_demo_guest" : "changegate_demo_guest";
  const cookie = (session: string, remainingMs: number) =>
    `${name}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(remainingMs / 1000)}${secure ? "; Secure" : ""}`;

  function session(headers: Incoming) {
    if (!validIngress(headers)) return undefined;
    const raw = headers.get("cookie")?.split(";").map(value => value.trim())
      .find(value => value.startsWith(name + "="))?.slice(name.length + 1);
    return raw && opaque.safeParse(raw).success ? invites.check(raw) : undefined;
  }

  return {
    session,
    read(request: Request) {
      const valid = session(request.headers);
      return valid ? json({ ...valid, walkthrough: guestWalkthrough }) : error("GUEST_ACCESS_REQUIRED", 401);
    },
    async post(request: Request) {
      if (!validIngress(request.headers) || request.headers.get("origin") !== origin) return error("ORIGIN_DENIED", 403);
      try {
        const parsed = command.safeParse(await readGuestCommand(request));
        if (!parsed.success) return error("INVITE_INVALID_REQUEST", 400);
        const input = parsed.data;
        if (input.action === "redeem") {
          const result = invites.redeem(input.recipient, input.token, input.code);
          return json({ expiresAt: result.expiresAt }, 200, cookie(result.session, result.remainingMs));
        }
        if (!canManageDemoInvites(employeeFor(request.headers))) return error("INVITE_ADMIN_REQUIRED", 403);
        switch (input.action) {
          case "plan": return json(invites.plan(input.minutes));
          case "issue": return json(invites.issue(input.id, input.recipient, input.minutes, input.startsAt));
          case "revoke": invites.revoke(input.id); break;
          case "list": break;
        }
        return json(invites.list());
      } catch (failure) {
        return failure instanceof TeamError ? error(failure.code, failure.status) : error("INVITE_UNAVAILABLE", 503);
      }
    },
  };
}
