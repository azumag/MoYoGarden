export interface SettlementFamilyAdmissionReservation {
  reservationId: string;
  sourceRegionId: string;
  pioneerId: string;
  factionId: string;
  agentIds: string[];
  expiresAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReservation(value: unknown): value is SettlementFamilyAdmissionReservation {
  return isRecord(value)
    && typeof value.reservationId === "string" && value.reservationId.length > 0
    && typeof value.sourceRegionId === "string" && value.sourceRegionId.length > 0
    && typeof value.pioneerId === "string" && value.pioneerId.length > 0
    && typeof value.factionId === "string" && value.factionId.length > 0
    && Array.isArray(value.agentIds) && value.agentIds.length > 0
    && value.agentIds.every((agentId) => typeof agentId === "string" && agentId.length > 0)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs)
    && value.expiresAtMs > 0;
}

export function normalizeSettlementFamilyAdmissionReservations(
  stored: unknown,
  presentAgentIds: ReadonlySet<string>,
  now: number,
): { reservations: SettlementFamilyAdmissionReservation[]; changed: boolean } {
  const input = Array.isArray(stored) ? stored : [];
  let changed = stored !== undefined && !Array.isArray(stored);
  const reservations: SettlementFamilyAdmissionReservation[] = [];
  for (const value of input) {
    if (!isReservation(value) || value.expiresAtMs <= now) {
      changed = true;
      continue;
    }
    const pendingAgentIds = [...new Set(value.agentIds)]
      .filter((agentId) => !presentAgentIds.has(agentId));
    if (pendingAgentIds.length === 0) {
      changed = true;
      continue;
    }
    if (
      pendingAgentIds.length !== value.agentIds.length
      || pendingAgentIds.some((agentId, index) => agentId !== value.agentIds[index])
    ) changed = true;
    reservations.push({ ...value, agentIds: pendingAgentIds });
  }
  return { reservations, changed };
}

export function settlementFamilyReservedSlots(
  reservations: readonly SettlementFamilyAdmissionReservation[],
  factionId: string,
): number {
  const reserved = new Set<string>();
  for (const reservation of reservations) {
    if (reservation.factionId !== factionId) continue;
    for (const agentId of reservation.agentIds) reserved.add(agentId);
  }
  return reserved.size;
}

export function upsertSettlementFamilyAdmissionReservation(
  reservations: readonly SettlementFamilyAdmissionReservation[],
  incoming: SettlementFamilyAdmissionReservation,
): SettlementFamilyAdmissionReservation[] {
  const existing = reservations.find((entry) => entry.reservationId === incoming.reservationId);
  const merged = existing === undefined
    ? { ...incoming, agentIds: [...new Set(incoming.agentIds)] }
    : {
        ...incoming,
        agentIds: [...new Set([...existing.agentIds, ...incoming.agentIds])],
        expiresAtMs: Math.max(existing.expiresAtMs, incoming.expiresAtMs),
      };
  return [...reservations.filter((entry) => entry.reservationId !== incoming.reservationId), merged];
}
