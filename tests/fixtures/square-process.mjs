import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts") || url.includes("/node_modules/")) return next(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  },
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith(".ts") && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    return next(specifier, context);
  },
});

const { TeamStore } = await import("../../src/merchant-team/store.ts");
const { SquareSandbox } = await import("../../src/merchant-team/square-sandbox.ts");
const { createTeamWorkspace } = await import("../../src/merchant-team/handler.ts");
const pending = new Map();
let sequence = 0;
let store;
let workspace;
let origin;

process.on("message", async message => {
  if (message.type === "init") {
    ({ origin } = message);
    const transport = (url, init) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      process.send({ type: "provider", id, url, method: init.method, body: init.body });
    });
    store = new TeamStore(message.path);
    workspace = createTeamWorkspace(store, message.users, origin, { square: new SquareSandbox(message.config, transport) });
    process.send({ type: "ready", pid: process.pid });
    return;
  }
  if (message.type === "providerReply") {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.reject(new Error("Simulated provider reply lost"));
    else call.resolve(new Response(message.body, { status: message.status }));
    return;
  }
  const response = await workspace.handle(new Request(origin + "/api/merchant", {
    method: "POST",
    headers: { Host: new URL(origin).host, Origin: origin, Cookie: message.cookie,
      "Content-Type": "application/json", "X-ChangeGate-Session": message.sessionVersion },
    body: JSON.stringify(message.command),
  }));
  process.send({ type: "reply", id: message.id, status: response.status,
    headers: [...response.headers], body: await response.text() });
});
process.on("disconnect", () => { store?.close(); });
