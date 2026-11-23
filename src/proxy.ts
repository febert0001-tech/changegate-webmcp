import { NextResponse, type NextRequest } from "next/server";
import { accessRequired, accessRequestHeaders, accessSettings, authorizeAccess, robotsTag } from "./merchant-team/cloudflare-access";

const protectedHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": robotsTag };
const guestPages = new Set(["/demo-invite", "/demo-guest", "/api/demo-access", "/favicon.ico"]);

export async function proxy(request: NextRequest) {
  if (!accessRequired()) return NextResponse.next();

  const path = request.nextUrl.pathname;
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && path === "/api/merchant/health") return NextResponse.next({ headers: protectedHeaders });

  const settings = accessSettings();
  if (settings && read && path === "/robots.txt" && request.headers.get("host") === settings.host) {
    return new NextResponse(request.method === "HEAD" ? null : "User-agent: *\nDisallow: /\n", {
      headers: { ...protectedHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const identity = settings && await authorizeAccess(settings, request.headers);
  const guestRoute = guestPages.has(path) || path.startsWith("/_next/static/");
  if (!identity || (identity.email !== settings?.presenterEmail && !guestRoute)) {
    return new NextResponse(request.method === "HEAD" ? null : "Access denied", { status: 403, headers: protectedHeaders });
  }
  return NextResponse.next({
    headers: protectedHeaders,
    request: { headers: accessRequestHeaders(request.headers, identity) },
  });
}
