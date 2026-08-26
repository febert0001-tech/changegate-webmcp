import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Gate 2 browser and authority boundary", () => {
  it("mounts a real Client Component that imports the integration and domain path", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    const page = source("src/app/page.tsx");

    expect(client.trimStart().startsWith('"use client";')).toBe(true);
    expect(client).toContain('createChangeGateOperations');
    expect(client).toContain('startWebMcpRegistration');
    expect(client).toContain('useEffect');
    expect(client.indexOf("useEffect")).toBeLessThan(client.indexOf("getWebMcpModelContext(document)"));
    expect(page).toContain("<ChangeGateWebMcp />");
  });

  it("keeps the mounted client dependency path free of Node-only crypto", () => {
    const browserReachableFiles = [
      "src/app/changegate-webmcp.tsx",
      "src/application/changegate-operations.ts",
      "src/domain/engine.ts",
      "src/domain/change/proposal-digest.ts",
      "src/webmcp/native-contract.ts",
      "src/webmcp/schemas.ts",
      "src/webmcp/tool-catalog.ts",
      "src/webmcp/registration.ts",
    ];

    for (const path of browserReachableFiles) {
      expect(source(path), path).not.toMatch(/(?:node:crypto|from\s+["']crypto["'])/u);
    }
  });

  it("contains no deprecated API or module-evaluation document access", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    const boundaryModules = [
      "src/application/changegate-operations.ts",
      "src/webmcp/native-contract.ts",
      "src/webmcp/schemas.ts",
      "src/webmcp/tool-catalog.ts",
      "src/webmcp/registration.ts",
    ].map(source);

    expect([client, ...boundaryModules].join("\n")).not.toContain("navigator.modelContext");
    expect(boundaryModules.join("\n")).not.toMatch(/\bdocument\b/u);
  });

  it("keeps human approval and reducer dispatch out of the WebMCP adapter", () => {
    const catalog = source("src/webmcp/tool-catalog.ts");

    expect(catalog).not.toContain("HumanApproval");
    expect(catalog).not.toContain("HUMAN_APPROVE");
    expect(catalog).not.toContain("reduceChangeGate");
    expect(catalog).not.toContain("approve_change");
    expect(catalog).not.toContain("execute_approved_change");
    expect(catalog).not.toContain("request_rollback");
  });
});
