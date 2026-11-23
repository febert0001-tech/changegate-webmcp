import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

type HeadersIn = Pick<Headers, "get">;
export type AccessIdentity = { email: string; subject: string };
type AccessSettings = { host: string; issuer: string; audience: string; presenterEmail: string };

const identityEmailHeader = "x-changegate-access-email";
const identitySubjectHeader = "x-changegate-access-subject";
export const robotsTag = "noindex, nofollow, noarchive";

export function accessRequired(env = process.env) {
  return env.CHANGEGATE_TEAM_MODE === "railway-demo" && Boolean(
    env.CHANGEGATE_ACCESS_MODE || env.CHANGEGATE_ACCESS_HOST || env.CHANGEGATE_ACCESS_ISSUER ||
    env.CHANGEGATE_ACCESS_AUDIENCE || env.CHANGEGATE_ACCESS_PRESENTER_EMAIL,
  );
}

export function normalizeAccessEmail(value: unknown) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ? email : undefined;
}

export function accessSettings(env = process.env): AccessSettings | undefined {
  const host = env.CHANGEGATE_ACCESS_HOST?.trim().toLowerCase();
  const issuer = env.CHANGEGATE_ACCESS_ISSUER?.trim();
  const audience = env.CHANGEGATE_ACCESS_AUDIENCE?.trim();
  const presenterEmail = normalizeAccessEmail(env.CHANGEGATE_ACCESS_PRESENTER_EMAIL);
  if (env.CHANGEGATE_ACCESS_MODE !== "required" || !host || host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      host === "railway.app" || host.endsWith(".railway.app") ||
      !issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
      !audience || !/^[a-f0-9]{64}$/.test(audience) || !presenterEmail) return undefined;
  return { host, issuer, audience, presenterEmail };
}

let remoteKeys: { issuer: string; resolver: JWTVerifyGetKey } | undefined;

function keysFor(issuer: string) {
  if (remoteKeys?.issuer !== issuer) {
    remoteKeys = { issuer, resolver: createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
      timeoutDuration: 3000, cooldownDuration: 5000, cacheMaxAge: 300_000,
    }) };
  }
  return remoteKeys.resolver;
}

export async function authorizeAccess(settings: AccessSettings, headers: HeadersIn): Promise<AccessIdentity | undefined> {
  if (headers.get("host") !== settings.host || headers.get("x-forwarded-host") !== settings.host ||
      headers.get("x-forwarded-proto") !== "https") return undefined;
  const assertion = headers.get("cf-access-jwt-assertion");
  if (!assertion || assertion.length > 8192) return undefined;
  try {
    const { payload } = await jwtVerify(assertion, keysFor(settings.issuer), {
      issuer: settings.issuer, audience: settings.audience, algorithms: ["RS256"],
      requiredClaims: ["exp", "nbf", "sub", "email"],
    });
    const email = normalizeAccessEmail(payload.email);
    if (email && payload.type === "app" && payload.sub && /^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub)) {
      return { email, subject: payload.sub };
    }
  } catch {
    // Missing keys, expired assertions and signature failures all deny access.
  }
}

export function accessIdentity(headers: HeadersIn): AccessIdentity | undefined {
  const email = normalizeAccessEmail(headers.get(identityEmailHeader));
  const subject = headers.get(identitySubjectHeader);
  return email && subject ? { email, subject } : undefined;
}

export function accessRequestHeaders(incoming: Headers, identity: AccessIdentity) {
  // Replace any caller-supplied values with the identity verified by Proxy.
  const headers = new Headers(incoming);
  headers.delete("cf-access-jwt-assertion");
  headers.set(identityEmailHeader, identity.email);
  headers.set(identitySubjectHeader, identity.subject);
  return headers;
}
