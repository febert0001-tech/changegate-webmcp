import { describe, expect, it } from "vitest";

import { CANONICAL_SCENARIO } from "./canonical-scenario";
import { SERVICE_IDS } from "./types";

describe("canonical scenario contract", () => {
  it("defines the exact deterministic four-service incident fixture", () => {
    expect(CANONICAL_SCENARIO.services).toHaveLength(4);
    expect(CANONICAL_SCENARIO.services.map(({ id }) => id)).toEqual(SERVICE_IDS);
    expect(CANONICAL_SCENARIO.services).toEqual([
      { id: "web-server", displayName: "Web Server", health: "HEALTHY" },
      { id: "database", displayName: "Database", health: "HEALTHY" },
      {
        id: "agent-gateway",
        displayName: "Agent Gateway",
        health: "DEGRADED",
      },
      {
        id: "knowledge-store",
        displayName: "Knowledge Store",
        health: "HEALTHY",
      },
    ]);
  });
});
