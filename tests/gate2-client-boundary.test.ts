import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

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

describe("Gate 4 Unit 4A human Execute source boundary", () => {
  it("captures identity during render and passes only that identity from the Execute callback", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    const tree = ts.createSourceFile("client.tsx", client, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = tree.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "ChangeGateWebMcp");
    if (!component?.body) throw new Error("Missing client component");
    const capture = component.body.statements.find((statement) =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
        declaration.name.getText(tree) === "pendingExecution"));
    expect(capture?.getText(tree)).toBe("const pendingExecution = operations.getPendingRefundExecution();");
    expect(client.match(/operations\.getPendingRefundExecution\(/gu)).toHaveLength(1);

    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith(".executeApprovedRefund")) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.expression.getText(tree)).toBe("operations.executeApprovedRefund");
    expect(call.arguments.map((argument) => argument.getText(tree))).toEqual(["pendingExecution"]);
    let ancestor: ts.Node = call;
    while (!ts.isArrowFunction(ancestor) && ancestor.parent) ancestor = ancestor.parent;
    expect(ts.isArrowFunction(ancestor)).toBe(true);
    // Exact callback body rules out fresh reads, business values, and secondary calls.
    expect(ancestor.getText(tree).replace(/\s+/gu, " ")).toBe(
      "() => { if (pendingExecution !== null) { operations.executeApprovedRefund(pendingExecution); } }",
    );
    expect(ts.isJsxExpression(ancestor.parent) && ts.isJsxAttribute(ancestor.parent.parent)
      ? ancestor.parent.parent.name.getText(tree) : null).toBe("onClick");
    expect(client).toMatch(/proposal\.lifecycle === "APPROVED" \? \(\s*isRefund \? \(/u);
    expect(client).toMatch(/pendingExecution !== null \? \([\s\S]*?Execute approved \{amount\} refund/u);
    expect(client).toContain("hasRefundProposalShape(proposal)");
  });

  it("keeps registration on the facade and human/private capabilities outside the adapter", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    expect(client).toContain("createWebMcpOperationsFacade(operations)");
    expect(client).toContain("startWebMcpRegistration(modelContext, webMcpOperations)");
    const adapter = ["src/webmcp/tool-catalog.ts", "src/webmcp/registration.ts"].map(source).join("\n");
    for (const forbidden of ["approvePendingChange", "rejectPendingChange", "getPendingRefundExecution",
      "executeApprovedRefund", "applyAuthorizedRefund", "readRefundState", "createRefundVerifier"]) {
      expect(adapter).not.toContain(forbidden);
    }
  });

  it("derives refund status from lifecycle, preserves gateway non-execution, and displays the existing audit projection", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    const page = source("src/app/page.tsx");
    for (const lifecycle of ["APPROVED", "EXECUTING", "VERIFYING", "SUCCEEDED", "FAILED"]) {
      expect(client).toContain(`proposal.lifecycle === "${lifecycle}"`);
    }
    for (const copy of ["Approval does not execute.", "Approved — execution still blocked",
      "Execution in progress", "Independent readback",
      "<strong>VERIFIED</strong>", "Independent ledger readback matched the exact", "FAILED CLOSED",
      "A failed result does not prove no ledger write occurred.",
      "Approved for authorization only. No change has executed."]) {
      expect(client).toContain(copy);
    }
    expect(client).toContain("const audit = operations.getAuditTrail();");
    expect(client).toContain("audit.events.map");
    expect(client).toContain("{event.type}");
    expect(client).toContain("{event.lifecycle.replaceAll");
    expect(client.slice(client.indexOf("<section"))).not.toMatch(/(?:result|command)\.status/u);
    expect(page).not.toContain("Consequential execution remains deliberately absent");
    expect(client).toContain("Refund execution requires a second human decision.");
    expect(client).toContain("Gateway execution is unavailable.");
  });
});

describe("Gate 4 Unit 4B presentation boundary", () => {
  it("derives money, lifecycle and flow from existing projections without adding business capabilities", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    expect(client).toContain("proposal.parameters.amountCents / 100");
    expect(client).toContain('const lifecycle = proposal?.lifecycle ?? "NONE"');
    expect(client).toContain('audit.events.at(-1)?.type === "REFUND_VERIFICATION_COMPLETED"');
    for (const stage of ["AI proposal", "Human approval", "Human execute", "Independent verification"]) {
      expect(client).toContain(stage);
    }
    const tree = ts.createSourceFile("client.tsx", client, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const calls = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(tree).startsWith("operations.")) {
        calls.add(node.expression.getText(tree));
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect([...calls].sort()).toEqual([
      "operations.approvePendingChange", "operations.executeApprovedRefund", "operations.getAuditTrail",
      "operations.getChangeProposal", "operations.getPendingRefundExecution", "operations.rejectPendingChange",
    ]);
  });

  it("keeps availability truthful, immutable details accessible, and audit actors and sequences visible", () => {
    const client = source("src/app/changegate-webmcp.tsx");
    expect(client).toContain('if (result.status === "REGISTERED") setAvailability("AVAILABLE")');
    expect(client.match(/setAvailability\("AVAILABLE"\)/gu)).toHaveLength(1);
    expect(client).toContain("{LABELS[availability]}");
    expect(client).toContain("7 safe tools registered");
    expect(client).toContain("7 tools</span>");
    for (const field of ["proposalId", "proposalDigest", "target", "action", "parameters", "preconditions"]) {
      expect(client).toContain(`proposal.${field}`);
    }
    expect(client).toContain('data-actor={event.actor}');
    expect(client).toContain('String(event.sequence).padStart(2, "0")');
    expect(client).toContain('aria-live="polite"');
    expect(client).toContain('aria-current={state === "current" ? "step" : undefined}');
    const css = source("src/app/page.module.css");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
