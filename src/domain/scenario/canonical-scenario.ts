import type { CanonicalScenario } from "./types";

/**
 * Gate 0.5 contract fixture. This is data only, not a simulator or reset
 * implementation. Its values must remain deterministic and immutable.
 */
export const CANONICAL_SCENARIO = {
  services: [
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
  ],
} as const satisfies CanonicalScenario;
