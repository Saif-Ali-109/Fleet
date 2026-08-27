import { randomUUID } from "node:crypto";
import type { ProviderName, Role } from "./types.ts";

export const MANAGER_ID = process.env.FLEET_MANAGER_ID?.trim() || randomUUID();

export interface RequestIdentity {
  managerId: string;
  runId: string;
  workerId: string;
  sessionId: string;
  role: Role;
  model: string;
  requestId: string;
  attempt: number;
}

export type TelemetryKind =
  | "reservation"
  | "reservation_wait"
  | "reservation_rejection"
  | "retry"
  | "provider_completion"
  | "provider_rate_limit"
  | "metadata_model_discovery";

export interface TelemetryEvent {
  t: "telemetry";
  event: TelemetryKind;
  timestamp: string;
  managerId: string;
  runId?: string;
  workerId?: string;
  sessionId?: string;
  role?: Role;
  model?: string;
  provider?: ProviderName;
  requestId: string;
  attempt?: number;
  reservationId?: string;
  status?: string;
  waitMs?: number;
  blockedDimension?: string;
  httpStatus?: number;
  trafficClass?: "metadata";
  generationReservation?: false;
}

export function newRequestId(): string {
  return randomUUID();
}
