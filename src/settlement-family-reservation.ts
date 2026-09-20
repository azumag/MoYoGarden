export interface SettlementFamilyAdmissionReservation {
  reservationId: string;
  sourceRegionId: string;
  pioneerId: string;
  factionId: string;
  agentIds: string[];
  expiresAtMs: number;
  // Per-follower lease expiry lets one retry renew its own capacity promise
  // without keeping canceled siblings reserved for the whole family TTL.
  // Optional for persisted reservations written by older deployments.
  agentExpiresAtMs?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentExpiryMap(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.entries(value).every(([agentId, expiresAtMs]) => (
      agentId.length > 0
      && typeof expiresAtMs === "number"
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > 0
    ));
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
    && value.expiresAtMs > 0
    && (value.agentExpiresAtMs === undefined || isAgentExpiryMap(value.agentExpiresAtMs));
}

function settlementFamilyAgentLeaseExpiry(
  reservation: SettlementFamilyAdmissionReservation,
  agentId: string,
): number {
  const perAgentExpiry = reservation.agentExpiresAtMs?.[agentId];
  return typeof perAgentExpiry === "number" && Number.isFinite(perAgentExpiry) && perAgentExpiry > 0
    ? perAgentExpiry
    : reservation.expiresAtMs;
}

function removeSettlementFamilyReservationAgents(
  reservation: SettlementFamilyAdmissionReservation,
  agentIdsToRemove: ReadonlySet<string>,
): SettlementFamilyAdmissionReservation | undefined {
  const agentIds = reservation.agentIds.filter((agentId) => !agentIdsToRemove.has(agentId));
  if (agentIds.length === 0) return undefined;
  const agentExpiresAtMs = reservation.agentExpiresAtMs === undefined
    ? undefined
    : Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        settlementFamilyAgentLeaseExpiry(reservation, agentId),
      ]));
  const expiresAtMs = agentExpiresAtMs === undefined
    ? reservation.expiresAtMs
    : Math.max(...Object.values(agentExpiresAtMs));
  return {
    ...reservation,
    agentIds,
    expiresAtMs,
    ...(agentExpiresAtMs === undefined ? {} : { agentExpiresAtMs }),
  };
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
    if (!isReservation(value)) {
      changed = true;
      continue;
    }
    const uniqueAgentIds = [...new Set(value.agentIds)];
    const pendingAgentIds = uniqueAgentIds.filter((agentId) => (
      !presentAgentIds.has(agentId)
      && settlementFamilyAgentLeaseExpiry(value, agentId) > now
    ));
    if (pendingAgentIds.length === 0) {
      changed = true;
      continue;
    }

    const normalizedExpiryByAgent = value.agentExpiresAtMs === undefined
      ? undefined
      : Object.fromEntries(pendingAgentIds.map((agentId) => [
          agentId,
          settlementFamilyAgentLeaseExpiry(value, agentId),
        ]));
    const expiresAtMs = normalizedExpiryByAgent === undefined
      ? value.expiresAtMs
      : Math.max(...Object.values(normalizedExpiryByAgent));
    if (
      pendingAgentIds.length !== value.agentIds.length
      || pendingAgentIds.some((agentId, index) => agentId !== value.agentIds[index])
      || expiresAtMs !== value.expiresAtMs
      || (
        value.agentExpiresAtMs !== undefined
        && Object.keys(value.agentExpiresAtMs).length !== pendingAgentIds.length
      )
    ) changed = true;
    reservations.push({
      ...value,
      agentIds: pendingAgentIds,
      expiresAtMs,
      ...(normalizedExpiryByAgent === undefined
        ? {}
        : { agentExpiresAtMs: normalizedExpiryByAgent }),
    });
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

export function releaseSettlementFamilyAdmissionAgent(
  reservations: readonly SettlementFamilyAdmissionReservation[],
  agentId: string,
  expiresAtCutoffMs: number,
): SettlementFamilyAdmissionReservation[] {
  // A release can cross a retry that refreshes the same stable follower's
  // admission lease. Fence at the follower lease rather than the family-wide
  // max expiry so renewing one sibling cannot keep an abandoned sibling slot.
  if (agentId.length === 0 || !Number.isFinite(expiresAtCutoffMs)) return [...reservations];
  return reservations.flatMap((reservation) => {
    if (
      !reservation.agentIds.includes(agentId)
      || settlementFamilyAgentLeaseExpiry(reservation, agentId) > expiresAtCutoffMs
    ) return [reservation];
    const trimmed = removeSettlementFamilyReservationAgents(
      reservation,
      new Set([agentId]),
    );
    return trimmed === undefined ? [] : [trimmed];
  });
}

export function upsertSettlementFamilyAdmissionReservation(
  reservations: readonly SettlementFamilyAdmissionReservation[],
  incoming: SettlementFamilyAdmissionReservation,
): SettlementFamilyAdmissionReservation[] {
  const existing = reservations.find((entry) => entry.reservationId === incoming.reservationId);
  const agentIds = existing === undefined
    ? [...new Set(incoming.agentIds)]
    : [...new Set([...existing.agentIds, ...incoming.agentIds])];
  const existingAgentIds = new Set(existing?.agentIds ?? []);
  const incomingAgentIds = new Set(incoming.agentIds);
  const agentExpiresAtMs = Object.fromEntries(agentIds.map((agentId) => {
    const expiries: number[] = [];
    if (existing !== undefined && existingAgentIds.has(agentId)) {
      expiries.push(settlementFamilyAgentLeaseExpiry(existing, agentId));
    }
    if (incomingAgentIds.has(agentId)) {
      expiries.push(settlementFamilyAgentLeaseExpiry(incoming, agentId));
    }
    return [agentId, Math.max(...expiries)];
  }));
  const merged: SettlementFamilyAdmissionReservation = {
    ...incoming,
    agentIds,
    agentExpiresAtMs,
    expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),
  };

  // One stable follower must have one destination-side admission owner. Multiple
  // settled pioneers can legitimately retry family registration toward the same
  // region, and the source-side target marker is region-scoped rather than
  // pioneer-scoped. Without collapsing old reservation owners, the same follower
  // can remain attached to several reservation IDs until TTL cleanup. Slot
  // counting deduplicates that state, but releases and diagnostics then have
  // ambiguous route ownership. Treat the newest successful registration as the
  // authoritative owner while preserving unrelated siblings in older families.
  const preserved = reservations.flatMap((reservation) => {
    if (reservation.reservationId === incoming.reservationId) return [];
    const trimmed = removeSettlementFamilyReservationAgents(reservation, incomingAgentIds);
    return trimmed === undefined ? [] : [trimmed];
  });
  return [...preserved, merged];
}
