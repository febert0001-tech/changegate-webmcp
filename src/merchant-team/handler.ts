import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { TeamError, teamCommand, type Employee, type TeamSession } from "./contracts";
import type { TeamStore } from "./store";

const hash = promisify(scrypt);
const cookieName = "changegate_team_session";
const sessionSeconds = 8 * 60 * 60;
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const cookie = (token: string, age: number) =>
  `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
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
    if (size > 16_384) {
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

export function createTeamWorkspace(store: TeamStore, roster: readonly Employee[], origin: string) {
  const employees = new Map(roster.map((employee) => [employee.username, employee]));
  const expectedHost = new URL(origin).host;
  const expectedSalt = randomBytes(16);
  const expectedHash = randomBytes(32);
  function tokenDigest(headers: Pick<Headers, "get">) {
    const token = headers.get("cookie")?.split(";").map((item) => item.trim())
      .find((item) => item.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    return token && /^[0-9a-f]{64}$/.test(token) ? digest(token) : undefined;
  }

  function authenticate(headers: Pick<Headers, "get">) {
    if (headers.get("host") !== expectedHost) return undefined;
    const token = tokenDigest(headers);
    if (!token) return undefined;
    const session = store.getSession(token);
    const employee = session && employees.get(session.username);
    if (!employee || employee.merchantId !== session.merchantId ||
        digest(employee.passwordHash) !== session.passwordVersion) return undefined;
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
    if (request.headers.get("host") !== expectedHost || request.headers.get("origin") !== origin) {
      return json({ error: "ORIGIN_DENIED" }, 403);
    }
    try {
      const parsed = teamCommand.safeParse(await readCommand(request));
      if (!parsed.success) return json({ error: "INVALID_COMMAND" }, 400);
      const command = parsed.data;
      if (command.action === "signIn") {
        const candidate = employees.get(command.username);
        const salt = candidate ? Buffer.from(candidate.salt, "hex") : expectedSalt;
        const actual = await hash(command.password, salt, 32) as Buffer;
        const expected = candidate ? Buffer.from(candidate.passwordHash, "hex") : expectedHash;
        if (!timingSafeEqual(actual, expected) || !candidate) return json({ error: "SIGN_IN_FAILED" }, 401);
        const token = randomBytes(32).toString("hex");
        const tokenHash = digest(token);
        store.replaceSession(tokenHash, candidate, digest(candidate.passwordHash),
          Date.now() + sessionSeconds * 1000, tokenDigest(request.headers));
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
            case "create": return json(store.create(employee, command.reference), 201);
            default: return json(store.change(employee, command, roster));
          }
      }
    } catch (error) {
      return error instanceof TeamError ? json({ error: error.code }, error.status)
        : json({ error: "WORKSPACE_UNAVAILABLE" }, 503);
    }
  }

  return {
    handle,
    employeeFor: (headers: Pick<Headers, "get">) => authenticate(headers)?.employee,
    open: (employee: Employee, id: string) => store.open(employee, id),
  };
}
