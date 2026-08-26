export const SERVICE_IDS = [
  "web-server",
  "database",
  "agent-gateway",
  "knowledge-store",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

export const SERVICE_HEALTH = ["HEALTHY", "DEGRADED"] as const;

export type ServiceHealth = (typeof SERVICE_HEALTH)[number];

export interface CanonicalService {
  readonly id: ServiceId;
  readonly displayName: string;
  readonly health: ServiceHealth;
}

export interface CanonicalScenario {
  readonly services: readonly CanonicalService[];
}
