import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("browser-reachable domain boundary", () => {
  it("contains no Node-only crypto import", () => {
    const digestSource = readFileSync(
      resolve(process.cwd(), "src/domain/change/proposal-digest.ts"),
      "utf8",
    );
    const engineSource = readFileSync(resolve(process.cwd(), "src/domain/engine.ts"), "utf8");

    expect(digestSource).not.toMatch(/(?:node:crypto|from\s+["']crypto["'])/u);
    expect(engineSource).not.toMatch(/(?:node:crypto|from\s+["']crypto["'])/u);
    expect(digestSource).toContain('@noble/hashes/sha2.js');
  });
});
