import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { TeamError, teamCommand, type Employee, type TeamSession } from "./contracts";
import type { TeamStore } from "./store";
import { csvLimit, inspectRefundCsv, reviewRefundCsv } from "./refund-csv";

const hash = promisify(scrypt);
const sessionSeconds = 8 * 60 * 60;
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const json = (value: unknown, status = 200, sessionCookie?: string) => Response.json(value, {
  status, headers: { ...responseHeaders, ...(sessionCookie && { "Set-Cookie": sessionCookie }) },
});

async function readCommand(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) {
    throw new TeamError("JSON_REQUIRED", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 6 * csvLimit + 1024) {
      void reader.cancel().catch(() => {});
      throw new TeamError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TeamError("INVALID_JSON", 400);
  }
}

export function createTeamWorkspace(store: TeamStore, roster: readonly Employee[], origin: string,
  { staging = false }: { staging?: boolean } = {}) {
  const cookieName = staging ? "__Host-changegate_team_session" : "changegate_team_session";
  const cookie = (token: string, age: number) =>
    `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${staging ? "; Secure" : ""}`;
  const employees = new Map(roster.map((employee) => [employee.username, employee]));
  const passwordVersion = (employee: Employee) => digest(employee.passwordHash);
  store.pruneSessions(roster.map((employee) => ({
    username: employee.username, merchantId: employee.merchantId, passwordVersion: passwordVersion(employee),
  })));
  const expectedHost = new URL(origin).host;
  const expectedSalt = randomBytes(16);
  const expectedHash = randomBytes(32);
  function validIngress(headers: Pick<Headers, "get">) {
    return headers.get("host") === expectedHost &&
      (!staging || (headers.get("x-forwarded-proto") === "https" && headers.get("x-forwarded-host") === expectedHost));
  }

  function tokenDigest(headers: Pick<Headers, "get">) {
    const token = headers.get("cookie")?.split(";").map((item) => item.trim())
      .find((item) => item.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    return token && /^[0-9a-f]{64}$/.test(token) ? digest(token) : undefined;
  }

  function authenticate(headers: Pick<Headers, "get">) {
    if (!validIngress(headers)) return undefined;
    const token = tokenDigest(headers);
    if (!token) return undefined;
    const session = store.getSession(token);
    const employee = session && employees.get(session.username);
    if (!employee || employee.merchantId !== session.merchantId ||
        passwordVersion(employee) !== session.passwordVersion) return undefined;
    return { employee, token, version: digest(token) };
  }

  function projectSession(employee: Employee, version: string): TeamSession {
    return {
      sessionVersion: version,
      username: employee.username, name: employee.name, merchantName: employee.merchantName,
      coworkers: roster.filter((member) => member.merchantId === employee.merchantId)
        .map(({ username, name }) => ({ username, name })),
    };
  }

  async function handle(request: Request): Promise<Response> {
    if (!validIngress(request.headers) || request.headers.get("origin") !== origin) {
      return json({ error: "ORIGIN_DENIED" }, 403);
    }
    try {
      const parsed = teamCommand.safeParse(await readCommand(request));
      if (!parsed.success) return json({ error: "INVALID_COMMAND" }, 400);
      const command = parsed.data;
      if (command.action === "signIn") {
        if (staging) {
          const ip = request.headers.get("x-real-ip");
          if (!ip || !isIP(ip)) return json({ error: "ORIGIN_DENIED" }, 403);
          if (!store.allowSignIn(digest(ip))) return json({ error: "SIGN_IN_LIMIT" }, 429);
        }
        const candidate = employees.get(command.username);
        const salt = candidate ? Buffer.from(candidate.salt, "hex") : expectedSalt;
        const actual = await hash(command.password, salt, 32) as Buffer;
        const expected = candidate ? Buffer.from(candidate.passwordHash, "hex") : expectedHash;
        if (!timingSafeEqual(actual, expected) || !candidate) return json({ error: "SIGN_IN_FAILED" }, 401);
        const token = randomBytes(32).toString("hex");
        const tokenHash = digest(token);
        store.replaceSession(tokenHash, candidate, passwordVersion(candidate),
          Date.now() + sessionSeconds * 1000, tokenDigest(request.headers), command.recoverSession === true);
        return json(projectSession(candidate, digest(tokenHash)), 200, cookie(token, sessionSeconds));
      }
      const identity = authenticate(request.headers);
      if (!identity) return json({ error: "SIGN_IN_REQUIRED" }, 401);
      const { employee, token, version } = identity;
      switch (command.action) {
        case "session": return json(projectSession(employee, version));
        case "workspace": {
          const cases = store.list(employee);
          const detail = command.id && cases.some(({ id }) => id === command.id)
            ? store.open(employee, command.id) : null;
          return json({ session: projectSession(employee, version), cases, detail });
        }
        case "list": return json(store.list(employee));
        case "open": return json(store.open(employee, command.id));
        default:
          if (request.headers.get("x-changegate-session") !== version) {
            return json({ error: "SESSION_CHANGED" }, 409);
          }
          switch (command.action) {
            case "signOut":
              store.revokeSession(token);
              return json(null, 200, cookie("", 0));
            case "create": return json(store.create(employee, command.reference, token), 201);
            case "inspectCsv": return json(inspectRefundCsv(command.text));
            case "previewCsv": return json(reviewRefundCsv(command.text, command.mapping));
            case "importCsv": return json(store.importRefunds(employee, token, command.text,
              () => reviewRefundCsv(command.text, command.mapping)));
            case "listImports": return json(store.listImports(employee));
            case "openImport": return json(store.openImport(employee, command.id));
            case "assignFinding": {
              const assignee = employees.get(command.assignee);
              if (!assignee || assignee.merchantId !== employee.merchantId) {
                return json({ error: "ASSIGNEE_UNAVAILABLE" }, 422);
              }
              return json(store.assignFinding(employee, token, command.id, assignee));
            }
            default: return json(store.change(employee, command, roster, token));
          }
      }
    } catch (error) {
      return error instanceof TeamError ? json({ error: error.code }, error.status)
        : json({ error: "WORKSPACE_UNAVAILABLE" }, 503);
    }
  }

  return {
    handle,
    openImport: (employee: Employee, id: string) => store.openImport(employee, id),
    employeeFor: (headers: Pick<Headers, "get">) => authenticate(headers)?.employee,
    open: (employee: Employee, id: string) => store.open(employee, id),
  };
}
