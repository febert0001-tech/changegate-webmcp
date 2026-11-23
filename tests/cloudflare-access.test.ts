import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../src/proxy";

const host = "demo.example.test";
const railway = "changegate-demo-demo.up.railway.app";
const issuer = "https://changegate-test.cloudflareaccess.com";
const audience = "a".repeat(64);
const presenter = "presenter@example.test";
let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const key = await generateKeyPair("RS256", { extractable: true });
  privateKey = key.privateKey;
  publicJwk = { ...await exportJWK(key.publicKey), kid: "test-key", use: "sig", alg: "RS256" };
});

beforeEach(() => {
  vi.stubEnv("CHANGEGATE_TEAM_MODE", "railway-demo");
  vi.stubEnv("CHANGEGATE_ACCESS_MODE", "required");
  vi.stubEnv("CHANGEGATE_ACCESS_HOST", host);
  vi.stubEnv("CHANGEGATE_ACCESS_ISSUER", issuer);
  vi.stubEnv("CHANGEGATE_ACCESS_AUDIENCE", audience);
  vi.stubEnv("CHANGEGATE_ACCESS_PRESENTER_EMAIL", presenter);
  vi.stubGlobal("fetch", vi.fn(async (value: string) => {
    expect(value).toBe(issuer + "/cdn-cgi/access/certs");
    return Response.json({ keys: [publicJwk] });
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function assertion(claims: JWTPayload = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: "invited@example.test", sub: "guest-subject", type: "app", iss: issuer, aud: [audience],
    exp: now + 3600, nbf: now - 60, ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
}

function request(path: string, { token = "", domain = host, method = "GET", headers = {} } = {}) {
  return new NextRequest("https://" + domain + path, { method, headers: {
    host: domain, "x-forwarded-host": domain, "x-forwarded-proto": "https",
    ...(token && { "cf-access-jwt-assertion": token }), ...headers,
  } });
}

describe("Cloudflare Access policy on the ChangeGate demo", () => {
  it("requires the branded hostname and an assertion on pages, APIs, WebMCP, downloads and assets", async () => {
    const token = await assertion();
    const headers = { cookie: "__Host-changegate_demo_guest=" + "c".repeat(43) };
    for (const path of ["/", "/demo-guest", "/api/demo-access", "/api/merchant", "/mcp",
      "/transactions/test/receipt", "/download", "/_next/static/chunks/demo.js", "/favicon.ico"]) {
      expect((await proxy(request(path, { headers }))).status, path).toBe(403);
      expect((await proxy(request(path, { token, domain: railway, headers }))).status, path).toBe(403);
    }
    expect((await proxy(request("/demo-guest", { token, domain: railway,
      headers: { "x-forwarded-host": host } }))).status).toBe(403);
    expect((await proxy(request("/demo-guest", { token, headers: { "x-forwarded-proto": "http" } }))).status).toBe(403);
  });

  it("accepts only signed, current application assertions for this Access app and team", async () => {
    const other = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const rejected = await Promise.all([
      assertion({ aud: ["other-app"] }), assertion({ iss: "https://other.cloudflareaccess.com" }),
      assertion({ exp: now - 1 }), assertion({ nbf: now + 60 }),
      assertion({ sub: "", email: undefined }), assertion({ type: "org" }), assertion({}, other.privateKey),
    ]);
    for (const token of [...rejected, "malformed"]) {
      expect((await proxy(request("/demo-guest", { token }))).status).toBe(403);
    }
    expect((await proxy(request("/demo-guest", {
      headers: { "cf-access-authenticated-user-email": "invited@example.test", "x-changegate-access-email": presenter },
    }))).status).toBe(403);
  });

  it("passes the verified identity only to allowed app routes and reserves merchant routes for the presenter", async () => {
    const token = await assertion();
    const headers = { "x-changegate-access-email": presenter, "x-changegate-access-subject": "spoofed" };
    const guest = await proxy(request("/demo-guest", { token, headers }));
    expect(guest.headers.get("x-middleware-next")).toBe("1");
    expect(guest.headers.get("x-middleware-request-x-changegate-access-email")).toBe("invited@example.test");
    expect(guest.headers.get("x-middleware-request-x-changegate-access-subject")).toBe("guest-subject");
    expect(guest.headers.has("x-middleware-request-cf-access-jwt-assertion")).toBe(false);
    expect(guest.headers.get("cache-control")).toBe("private, no-store");
    expect((await proxy(request("/api/demo-access", { token, method: "POST" }))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/merchant", { token, method: "POST", headers }))).status).toBe(403);
    expect((await proxy(request("/demo-access", { token }))).status).toBe(403);
    const presenterToken = await assertion({ email: presenter, sub: "presenter-subject" });
    expect((await proxy(request("/merchant", { token: presenterToken }))).headers.get("x-middleware-next")).toBe("1");
  });

  it("allows only readiness and the crawler directives without authentication and fails closed on partial settings", async () => {
    const health = "/api/merchant/health";
    expect((await proxy(request(health, { domain: railway }))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request(health, { domain: railway, method: "HEAD" }))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request(health, { domain: railway, method: "POST" }))).status).toBe(403);
    expect((await proxy(request(health + "/other", { domain: railway }))).status).toBe(403);
    const robots = await proxy(request("/robots.txt"));
    expect(robots.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect((await proxy(request("/robots.txt", { domain: railway }))).status).toBe(403);
    vi.stubEnv("CHANGEGATE_ACCESS_AUDIENCE", "");
    expect((await proxy(request("/demo-guest", { token: await assertion() }))).status).toBe(403);
    vi.stubEnv("CHANGEGATE_TEAM_MODE", "demo");
    expect((await proxy(request("/merchant"))).headers.get("x-middleware-next")).toBe("1");
  });
});
