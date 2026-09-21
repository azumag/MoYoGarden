import {
  normalizePendingArrivalRegistrations,
  type PendingArrivalRegistration,
} from "./storage-reservation-region.js";

export const ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS = 15 * 60 * 1_000;

export interface ArrivalTerminalReconciliationMarker {
  claimId: string;
  terminalExpiresAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isPendingArrivalRegistrationIncludingExpired(
  value: unknown,
): value is PendingArrivalRegistration {
  return isRecord(value)
    && typeof value.claimId === "string"
    && value.claimId.length > 0
    && typeof value.targetRegionId === "string"
    && value.targetRegionId.length > 0
    && isRecord(value.payload)
    && value.payload.claimId === value.claimId
    && positiveFinite(value.expiresAtMs) !== undefined;
}

export function pendingArrivalRegistrationsIncludingExpired(
  value: unknown,
): PendingArrivalRegistration[] {
  if (!Array.isArray(value)) return [];
  const byClaim = new Map<string, PendingArrivalRegistration>();
  for (const candidate of value) {
    if (!isPendingArrivalRegistrationIncludingExpired(candidate)) continue;
    const current = byClaim.get(candidate.claimId);
    if (
      current === undefined
      || candidate.expiresAtMs > current.expiresAtMs
      || (
        candidate.expiresAtMs === current.expiresAtMs
        && candidate.targetRegionId.localeCompare(current.targetRegionId) < 0
      )
    ) {
      byClaim.set(candidate.claimId, {
        claimId: candidate.claimId,
        targetRegionId: candidate.targetRegionId,
        payload: { ...candidate.payload },
        expiresAtMs: candidate.expiresAtMs,
      });
    }
  }
  return [...byClaim.values()].sort((a, b) =>
    a.claimId.localeCompare(b.claimId) || a.targetRegionId.localeCompare(b.targetRegionId)
  );
}

function isArrivalTerminalMarker(value: unknown): value is ArrivalTerminalReconciliationMarker {
  return isRecord(value)
    && typeof value.claimId === "string"
    && value.claimId.length > 0
    && positiveFinite(value.terminalExpiresAtMs) !== undefined;
}

export function normalizeArrivalTerminalMarkers(
  value: unknown,
): ArrivalTerminalReconciliationMarker[] {
  if (!Array.isArray(value)) return [];
  const byClaim = new Map<string, ArrivalTerminalReconciliationMarker>();
  for (const candidate of value) {
    if (!isArrivalTerminalMarker(candidate)) continue;
    const current = byClaim.get(candidate.claimId);
    if (current === undefined || candidate.terminalExpiresAtMs > current.terminalExpiresAtMs) {
      byClaim.set(candidate.claimId, {
        claimId: candidate.claimId,
        terminalExpiresAtMs: candidate.terminalExpiresAtMs,
      });
    }
  }
  return [...byClaim.values()].sort((a, b) => a.claimId.localeCompare(b.claimId));
}

export function beginArrivalTerminalGrace(
  pendingValue: unknown,
  markerValue: unknown,
  registration: PendingArrivalRegistration,
  targetRegionId: string,
  now = Date.now(),
): {
  pending: PendingArrivalRegistration[];
  markers: ArrivalTerminalReconciliationMarker[];
} {
  const terminalExpiresAtMs = now + ARRIVAL_REGISTRATION_TERMINAL_GRACE_MS;
  const pending = [
    ...normalizePendingArrivalRegistrations(pendingValue, now).filter((entry) =>
      entry.claimId !== registration.claimId
    ),
    {
      claimId: registration.claimId,
      targetRegionId,
      payload: { ...registration.payload },
      expiresAtMs: terminalExpiresAtMs,
    },
  ].sort((a, b) =>
    a.targetRegionId.localeCompare(b.targetRegionId) || a.claimId.localeCompare(b.claimId)
  );
  const markers = [
    ...normalizeArrivalTerminalMarkers(markerValue).filter((entry) =>
      entry.claimId !== registration.claimId
    ),
    { claimId: registration.claimId, terminalExpiresAtMs },
  ].sort((a, b) => a.claimId.localeCompare(b.claimId));
  return { pending, markers };
}

export function finishArrivalTerminalReconciliation(
  pendingValue: unknown,
  markerValue: unknown,
  claimId: string,
  now = Date.now(),
): {
  pending: PendingArrivalRegistration[];
  markers: ArrivalTerminalReconciliationMarker[];
} {
  return {
    pending: normalizePendingArrivalRegistrations(pendingValue, now).filter((entry) =>
      entry.claimId !== claimId
    ),
    markers: normalizeArrivalTerminalMarkers(markerValue).filter((entry) =>
      entry.claimId !== claimId
    ),
  };
}
