import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { TeamError, teamCommand, type Employee, type TeamSession } from "./contracts";
import type { TeamStore } from "./store";
import { alertPublicKey } from "./refund-alerts";
import { canReview, isDemoSaleReference } from "./refund-requests";
import { demoRegister } from "./demo-sales";
import { demoExplanation } from "./refund-ai-explanation";
import type { SquareSandbox } from "./square-sandbox";
import type { PayPalProvider } from "./paypal-provider";
import type { ElectronicProvider } from "./refund-requests";
import { csvLimit, inspectRefundCsv, reviewRefundCsv } from "./refund-csv";

import { compareRefunds } from "./refund-comparison";

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
    if (size > 12 * csvLimit + 2048) {
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

const hostedDemoActions = new Set([
  "listPilots", "openPilot", "startPilot", "inspectPilotCsv", "attachPilotFile", "savePilotBaseline", "revealPilot", "decidePilotIssue", "addPilotMiss", "savePilotTime", "savePilotDecision",
  "overnightDesk", "overnightOwner", "coverageSettings", "grantCoverage", "startDemoCoverage", "revokeCoverage", "claimOvernightCase", "requestOvernightFollowUp", "replyOvernight", "reassignOvernightCase",
  "signIn", "signOut", "session", "workspace", "demoShift", "shiftOverview", "startDemoShift", "nextDemoEvent", "replayDemoShift",
  "replayHeldDemoRefund",
  "recordDemoSale", "openDemoSale", "lookupOriginalSale",
  "refundAlertStatus", "listRefundRequests", "openRefundRequest", "createRefundRequest", "decideRefundRequest",
  "reportCashPayout", "cashDrawers", "openCashDrawer", "closeCashDrawer", "recordDrawerMovement",
  "weeklyCashReview",
  "recordDrawerFollowUp", "openDrawerCase", "record", "assign", "note", "resolve",
]);

const reviewerActions = new Set(["workspace", "session", "signOut", "overnightDesk", "claimOvernightCase", "requestOvernightFollowUp"]);

function merchantAccess(employee: Employee) {
  if (employee.role === "reviewer") throw new TeamError("CASE_NOT_FOUND", 404);
}

export function createTeamWorkspace(store: TeamStore, roster: readonly Employee[], origin: string,
  { staging = false, hostedDemo = false, ...providers }:
  { staging?: boolean; hostedDemo?: boolean; square?: SquareSandbox; paypal?: PayPalProvider } = {}) {
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

  function providerFor(employee: Employee, source: ElectronicProvider) {
    const provider = providers[source];
    if (!provider?.supports(employee.merchantId)) {
      throw new TeamError(source === "square" ? "SQUARE_NOT_CONNECTED" : "PAYPAL_NOT_CONNECTED", 503);
    }
    return provider;
  }
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
    const assignment = store.demo && demoRegister(employee);
    return {
      sessionVersion: version,
      username: employee.username, name: employee.name, merchantName: employee.merchantName,
      ...(employee.role && { role: employee.role }),
      reviewerConfigured: roster.some(member=>member.merchantId===employee.merchantId&&canReview(member.role)),
      paypalConnected: providers.paypal?.supports(employee.merchantId) ?? false,
      ...(employee.role !== "reviewer" && store.demo?.includes(employee) && { demoShift: true }),
      ...(assignment && { demoRegister: assignment }),
      ...(store.demo && canReview(employee.role) && { pilotEnabled: true }),
      ...(hostedDemo && { syntheticOnly: true }),
      coworkers: roster.filter((member) => employee.role !== "reviewer" && member.role !== "reviewer" && member.merchantId === employee.merchantId)
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
      if (hostedDemo && (!hostedDemoActions.has(command.action) ||
          (command.action === "createRefundRequest" && !command.demoRun && !isDemoSaleReference(command.terms.reference)) ||
          (command.action === "lookupOriginalSale" && !isDemoSaleReference(command.reference)))) {
        return json({ error: "DEMO_SHIFT_UNAVAILABLE" }, 404);
      }
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
      if (employee.role === "reviewer" && !reviewerActions.has(command.action)) throw new TeamError("COVERAGE_DENIED", 403);
      switch (command.action) {
        case "session": return json(projectSession(employee, version));
        case "workspace": {
          const cases = employee.role === "reviewer" ? [] : store.list(employee);
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
            case "listPilots":
            case "openPilot":
            case "startPilot":
            case "inspectPilotCsv":
            case "attachPilotFile":
            case "savePilotBaseline":
            case "revealPilot":
            case "decidePilotIssue":
            case "addPilotMiss":
            case "savePilotTime":
            case "savePilotDecision":
              return json(store.pilotCommand(employee, token, command, hostedDemo));
            case "overnightDesk":
            case "overnightOwner":
            case "coverageSettings":
            case "grantCoverage":
            case "startDemoCoverage":
            case "revokeCoverage":
            case "reassignOvernightCase":
            case "claimOvernightCase":
            case "requestOvernightFollowUp":
            case "replyOvernight":
              return json(store.overnightCommand(employee, token, roster, command));
            case "signOut":
              store.revokeSession(token);
              return json(null, 200, cookie("", 0));
            case "create": return json(store.create(employee, command.reference, token), 201);
            case "inspectCsv": return json(inspectRefundCsv(command.text));
            case "previewCsv": return json(reviewRefundCsv(command.text, command.mapping));
            case "importCsv": return json(store.importRefunds(employee, token, command.text,
              () => reviewRefundCsv(command.text, command.mapping)));
            case "previewComparison": {
              const { accepted, ...result } = compareRefunds(command.input);
              return json({ ...result, acceptedCount: accepted.length });
            }
            case "saveComparison": {
              const { merchant, processor } = command.input;
              const key = JSON.stringify(["refund-comparison-v1", merchant.text, processor.text]);
              return json(store.importRefunds(employee, token, key, () => compareRefunds(command.input)));
            }
            case "reviewSummary": return json(store.openReviewSummary(employee, command.id));
            case "recordDisposition": return json(store.recordDisposition(employee, token, command));
            case "refundAlertSettings": {
              if(!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED",403);
              return json({publicKey:store.demo ? null : alertPublicKey()});
            }
            case "enrollRefundAlerts": {
              if(!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED",403);
              if(store.demo || !alertPublicKey()) throw new TeamError("ALERTS_UNAVAILABLE",503);
              store.enrollRefundAlerts(employee,token,command.enrollment);
              return json(null);
            }
            case "removeRefundAlerts":
              store.removeRefundAlerts(employee,token,command.endpoint);
              return json(null);
            case "refundAlertStatus": {
              const refund = store.refundRequests.open(employee,command.id);
              const alerts = store.alerts.status(employee,command.id);
              const explanation = !hostedDemo ? undefined : command.includeSavedExplanation
                ? store.alerts.readDemoExplanation(employee,command.id)
                : command.includeExplanation && canReview(employee.role) ? demoExplanation(store.alerts,employee,refund) : undefined;
              return json(explanation ? alerts.map(alert => alert.phase === 0 ? { ...alert, explanation } : alert) : alerts);
            }
            case "lookupOriginalSale": {
              if (!command.source || command.source === "test") return json(store.lookupRefundSale(employee,token,command.reference));
              if (isDemoSaleReference(command.reference)) throw new TeamError("TRANSACTION_NOT_FOUND",404);
              const evidence = await providerFor(employee,command.source).lookup(command.reference);
              return json(store.lookupRefundSale(employee,token,command.reference,evidence));
            }
            case "refundPolicy": return json(store.refundRequests.policy(employee));
            case "setRefundPolicy": return json(store.setRefundPolicy(employee,token,command.thresholdCents));
            case "reportCashPayout": return json(store.reportCashPayout(employee,token,command.id,hostedDemo));
            case "cashDrawers":
            case "openCashDrawer":
            case "closeCashDrawer":
            case "recordDrawerMovement":
            case "recordDrawerFollowUp":
            case "openDrawerCase": return json(store.cashDrawer(employee, token, command));
            case "weeklyCashReview": return json(store.weeklyCashReview(employee, token, command.week, command.location));
            case "listRefundRequests": return json(store.refundRequests.list(employee));
            case "shiftOverview": return json(store.shiftOverview(employee,token,command.manual));
            case "recordDemoSale": return json(store.recordDemoSale(employee,token,command));
            case "openDemoSale": return json(store.openDemoSale(employee,token,command.reference));
            case "replayHeldDemoRefund": return json(store.replayHeldDemoRefund(employee,token,command.runId,roster));
            case "demoShift":
            case "startDemoShift":
            case "nextDemoEvent":
            case "replayDemoShift": return json(store.demoShift(employee,token,command));
            case "openRefundRequest": return json(store.refundRequests.open(employee,command.id));
            case "createRefundRequest": {
              const { source } = command.terms;
              if (!source || source === "test" || command.demoRun || isDemoSaleReference(command.terms.reference)) {
                return json(store.createRefundRequest(employee,token,command.submissionId,command.terms,undefined,command.demoRun));
              }
              const saved = store.refundRequests.replay(employee,command.submissionId,command.terms);
              if (saved) return json(saved);
              const evidence = await providerFor(employee,source).lookup(command.terms.reference);
              return json(store.createRefundRequest(employee,token,command.submissionId,command.terms,evidence));
            }
            case "executeElectronicRefund":
            case "verifyElectronicRefund":
              return json(await store.executeElectronicRefund(employee,token,command.id,providers,command.action === "verifyElectronicRefund"));
            case "decideRefundRequest": {
              store.refundRequests.open(employee, command.id);
              if (!canReview(employee.role)) throw new TeamError("TRANSACTION_ROLE_REQUIRED", 403);
              if (staging) {
                const ip = request.headers.get("x-real-ip");
                if (!ip || !isIP(ip)) throw new TeamError("ORIGIN_DENIED", 403);
                if (!store.allowSignIn(digest(ip))) throw new TeamError("SIGN_IN_LIMIT", 429);
              }
              const actual = await hash(command.password, Buffer.from(employee.salt,"hex"), 32) as Buffer;
              if (!timingSafeEqual(actual,Buffer.from(employee.passwordHash,"hex"))) throw new TeamError("TRANSACTION_CONFIRMATION_FAILED", 403);
              return json(store.decideRefundRequest(employee,token,command.id,command.decision));
            }
            case "listImports": return json(store.listImports(employee));
            case "openImport": return json(store.openImport(employee, command.id));
            case "assignFinding": {
              const assignee = employees.get(command.assignee);
              if (!assignee || assignee.role === "reviewer" || assignee.merchantId !== employee.merchantId) {
                return json({ error: "ASSIGNEE_UNAVAILABLE" }, 422);
              }
              return json(store.assignFinding(employee, token, command.id, assignee));
            }
            default:
              if (hostedDemo && !store.isDrawerCase(employee, command.id)) throw new TeamError("CASE_NOT_FOUND", 404);
              return json(store.change(employee, command, roster.filter(member => member.role !== "reviewer"), token));
          }
      }
    } catch (error) {
      return error instanceof TeamError ? json({ error: error.code }, error.status)
        : json({ error: "WORKSPACE_UNAVAILABLE" }, 503);
    }
  }

  return {
    handle,
    alerts:store.alerts,
    roster,
    openRefundRequest: (employee: Employee, id: string) => { merchantAccess(employee); return store.refundRequests.open(employee, id); },
    openImport: (employee: Employee, id: string) => { merchantAccess(employee); return store.openImport(employee, id); },
    employeeFor: (headers: Pick<Headers, "get">) => authenticate(headers)?.employee,
    open: (employee: Employee, id: string) => { merchantAccess(employee); return store.open(employee, id); },
  };
}
