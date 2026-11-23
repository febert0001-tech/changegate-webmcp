import { randomUUID, scryptSync } from "node:crypto";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DemoGuestWalkthrough } from "../src/app/merchant/demo-invite-panel";
import type { Employee } from "../src/merchant-team/contracts";
import { createTeamWorkspace } from "../src/merchant-team/handler";
import { TeamStore } from "../src/merchant-team/store";

const origin = "https://preview.example.test";
const host = new URL(origin).host;
const guestEmail = "guest@example.test";
const presenterEmail = "presenter@example.test";
const password = "synthetic-local-test";
const salt = "11".repeat(16);
const presenter: Employee = {
  username: "jordan", name: "Jordan Lee", merchantId: "harbor", merchantName: "Harbor Goods", role: "manager",
  salt, passwordHash: scryptSync(password, Buffer.from(salt, "hex"), 32).toString("hex"),
};
const example = "Held refund · Harbor Fuel";
const status = "Access ended";
const identity = (email: string, subject: string) => ({
  "x-changegate-access-email": email, "x-changegate-access-subject": subject,
});

let element: HTMLDivElement;
let root: Root;
let store: TeamStore;
let dom: Window;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-23T15:00:30Z"));
  dom = new Window({ url: origin });
  Object.assign(dom, { setTimeout, clearTimeout, setInterval, clearInterval });
  vi.stubGlobal("window", dom);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("Event", dom.Event);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  store = new TeamStore(":memory:", undefined, true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await dom.happyDOM.close();
});

async function separateSessions() {
  const workspace = createTeamWorkspace(store, [presenter], origin, { hostedDemo: true, presenterEmail });
  const api = workspace.demoAccess!;
  const ownerHeaders = identity(presenterEmail, "presenter");
  const guestHeaders = identity(guestEmail, "guest");
  const request = (path: string, headers: Record<string, string>, cookie = "", body?: object) =>
    new Request(origin + path, {
      method: body ? "POST" : "GET",
      headers: { host, origin, cookie, "content-type": "application/json", ...headers },
      ...(body && { body: JSON.stringify(body) }),
    });

  const signIn = await workspace.handle(request("/api/merchant", ownerHeaders, "", { action: "signIn", username: "jordan", password }));
  const staffCookie = signIn.headers.getSetCookie()[0]?.split(";")[0];
  expect(signIn.status, await signIn.clone().text()).toBe(200);
  expect(staffCookie).toBeDefined();
  const { sessionVersion } = await signIn.json() as { sessionVersion: string };
  const adminPost = (body: object) => api.post(request("/api/demo-access", ownerHeaders, staffCookie, body));
  const planResult = await adminPost({ action: "plan", recipient: "Synthetic Guest", recipientEmail: guestEmail, minutes: 30 });
  const plan = await planResult.json() as { startsAt: number };
  const id = randomUUID();
  const issued = await adminPost({ action: "issue", id, recipient: "Synthetic Guest", recipientEmail: guestEmail,
    minutes: 30, startsAt: plan.startsAt });
  const { token, code } = await issued.json() as { token: string; code: string };
  vi.setSystemTime(plan.startsAt);
  const redeemed = await api.post(request("/api/demo-access", guestHeaders, "", {
    action: "redeem", recipient: "Synthetic Guest", token, code,
  }));
  const guestCookie = redeemed.headers.getSetCookie()[0]?.split(";")[0];
  expect(redeemed.status).toBe(200);
  expect(guestCookie).toBeDefined();
  const guestRequest = () => request("/api/demo-access", guestHeaders, guestCookie);
  return {
    read: () => api.read(guestRequest()),
    pageAccess: () => api.session(guestRequest().headers),
    revoke: () => adminPost({ action: "revoke", id }),
    overview: () => workspace.handle(request("/api/merchant", { ...ownerHeaders, "x-changegate-session": sessionVersion },
      staffCookie, { action: "shiftOverview", manual: true })),
  };
}

const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
const showGuest = () => act(async () => root.render(<DemoGuestWalkthrough />));
const guestFetch = (sessions: Awaited<ReturnType<typeof separateSessions>>, read = sessions.read) =>
  vi.fn((_url: string, options?: RequestInit) => options?.method === "HEAD"
    ? new Response(null, { status: sessions.pageAccess() ? 204 : 401 })
    : read());

it("locks the open guest UI on the next poll and denies a separate read while the presenter remains authorized", async () => {
  const sessions = await separateSessions();
  expect((await sessions.overview()).status).toBe(200);
  vi.stubGlobal("fetch", guestFetch(sessions));
  await showGuest();
  expect(element.textContent).toContain(example);
  expect((await sessions.revoke()).status).toBe(200);
  const fresh = sessions.read();
  expect(fresh.status).toBe(401);
  expect(fresh.headers.get("cache-control")).toBe("private, no-store");
  expect(await fresh.json()).toEqual({ error: "GUEST_ACCESS_REQUIRED" });
  expect(sessions.pageAccess()).toBeUndefined();
  await advance(guestPollInterval);
  expect(element.textContent).toContain(status);
  expect(element.textContent).not.toContain(example);
  expect((await sessions.overview()).status).toBe(200);
});

const guestPollInterval = 1000;

it("clears already-displayed evidence within four seconds if the next request never returns", async () => {
  const sessions = await separateSessions();
  const read = vi.fn().mockImplementationOnce(sessions.read)
    .mockImplementation(() => new Promise(() => {}));
  const fetcher = guestFetch(sessions, read);
  vi.stubGlobal("fetch", fetcher);
  await showGuest();
  expect(element.textContent).toContain(example);
  await advance(3999);
  expect(read).toHaveBeenCalledTimes(2);
  expect(element.textContent).toContain(example);
  await advance(1);
  expect(element.textContent).toContain(status);
  expect(element.textContent).not.toContain(example);
  expect(fetcher.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
});

it("hides on suspend and never restores data from a response started before resuming", async () => {
  const sessions = await separateSessions();
  let reply: (response: Response) => void = () => {};
  const delayed = new Promise<Response>(resolve => { reply = resolve; });
  const captured = sessions.read();
  const read = vi.fn().mockImplementationOnce(sessions.read)
    .mockReturnValueOnce(delayed).mockImplementation(sessions.read);
  const fetcher = guestFetch(sessions, read);
  vi.stubGlobal("fetch", fetcher);
  await showGuest();
  await advance(guestPollInterval);
  expect(element.textContent).toContain(example);

  await act(async () => document.dispatchEvent(new Event("freeze")));
  expect(element.textContent).not.toContain(example);
  expect(fetcher.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
  expect((await sessions.revoke()).status).toBe(200);
  await act(async () => document.dispatchEvent(new Event("resume")));
  expect(read).toHaveBeenCalledTimes(3);
  expect(element.textContent).toContain(status);
  await act(async () => reply(captured));
  expect(element.textContent).not.toContain(example);
});

it("confirms access before revealing a resumed response authorized before revocation", async () => {
  const sessions = await separateSessions();
  let release: () => void = () => {};
  const read = vi.fn().mockImplementationOnce(sessions.read).mockImplementationOnce(() => {
    const response = sessions.read();
    expect(response.status).toBe(200);
    return new Promise<Response>(resolve => { release = () => resolve(response); });
  });
  const fetcher = guestFetch(sessions, read);
  vi.stubGlobal("fetch", fetcher);
  await showGuest();
  expect(element.textContent).toContain(example);

  await act(async () => document.dispatchEvent(new Event("freeze")));
  await act(async () => document.dispatchEvent(new Event("resume")));
  expect(element.textContent).not.toContain(example);
  expect(read).toHaveBeenCalledTimes(2);
  expect((await sessions.revoke()).status).toBe(200);
  await act(async () => release());

  expect(fetcher.mock.calls[3]?.[1]?.method).toBe("HEAD");
  expect(element.textContent).not.toContain(example);
  expect(element.textContent).toContain(status);
});
