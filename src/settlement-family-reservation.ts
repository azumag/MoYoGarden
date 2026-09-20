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
    const agentExpiryMapChanged = normalizedExpiryByAgent !== undefined && (
      Object.keys(value.agentExpiresAtMs ?? {}).length !== pendingAgentIds.length
      || pendingAgentIds.some((agentId) =>
        value.agentExpiresAtMs?.[agentId] !== normalizedExpiryByAgent[agentId]
      )
    );
    if (
      pendingAgentIds.length !== value.agentIds.length
      || pendingAgentIds.some((agentId, index) => agentId !== value.agentIds[index])
      || expiresAtMs !== value.expiresAtMs
      || agentExpiryMapChanged
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

  // Rolling deployments can leave duplicate follower ownership persisted by an
  // older writer even after new registrations have switched to single-owner
  // upserts. Repair that state during ordinary normalization instead of waiting
  // for another registration or the 24h TTL. Prefer the strongest still-live
  // per-agent lease; equal leases prefer the later array entry because upserts
  // append the newest owner. Unrelated siblings stay attached to their original
  // reservation and have their aggregate expiry recomputed by the trim helper.
  const ownerByAgent = new Map<string, { reservationIndex: number; expiresAtMs: number }>();
  for (const [reservationIndex, reservation] of reservations.entries()) {
    for (const agentId of reservation.agentIds) {
      const expiresAtMs = settlementFamilyAgentLeaseExpiry(reservation, agentId);
      const current = ownerByAgent.get(agentId);
      if (
        current === undefined
        || expiresAtMs > current.expiresAtMs
        || (expiresAtMs === current.expiresAtMs && reservationIndex > current.reservationIndex)
      ) {
        ownerByAgent.set(agentId, { reservationIndex, expiresAtMs });
      }
    }
  }

  const singleOwnerReservations = reservations.flatMap((reservation, reservationIndex) => {
    const duplicateAgentIds = new Set(reservation.agentIds.filter((agentId) =>
      ownerByAgent.get(agentId)?.reservationIndex !== reservationIndex
    ));
    if (duplicateAgentIds.size === 0) return [reservation];
    changed = true;
    const trimmed = removeSettlementFamilyReservationAgents(reservation, duplicateAgentIds);
    return trimmed === undefined ? [] : [trimmed];
  });

  return { reservations: singleOwnerReservations, changed };
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
  // The release cutoff is `releaseIssuedAtMs + leaseTtl`. Treat an exactly equal
  // lease as concurrent with the release, not older than it: Date.now() only has
  // millisecond resolution, so deleting equality can erase a fresh registration
  // that was accepted in the same millisecond as an old route was canceled.
  // Keeping that ambiguous slot until its bounded TTL is the fail-closed choice.
  if (agentId.length === 0 || !Number.isFinite(expiresAtCutoffMs)) return [...reservations];
  return reservations.flatMap((reservation) => {
    if (
      !reservation.agentIds.includes(agentId)
      || settlementFamilyAgentLeaseExpiry(reservation, agentId) >= expiresAtCutoffMs
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
  const uniqueIncomingAgentIds = [...new Set(incoming.agentIds)];

  // A follower's admission promise belongs to the stable follower and target
  // region, not to whichever settled pioneer happened to retry registration.
  // Keep the current reservation owner stable and treat another pioneer's retry
  // as a lease refresh. This removes response-order dependence: a delayed older
  // registration can extend bounded capacity conservatively, but cannot steal
  // ownership from the route that is already authoritative.
  const ownerByAgent = new Map<string, number>();
  for (const [reservationIndex, reservation] of reservations.entries()) {
    for (const agentId of reservation.agentIds) {
      const currentIndex = ownerByAgent.get(agentId);
      if (currentIndex === undefined) {
        ownerByAgent.set(agentId, reservationIndex);
        continue;
      }
      const current = reservations[currentIndex];
      if (current === undefined) continue;
      const currentExpiry = settlementFamilyAgentLeaseExpiry(current, agentId);
      const candidateExpiry = settlementFamilyAgentLeaseExpiry(reservation, agentId);
      if (
        candidateExpiry > currentExpiry
        || (candidateExpiry === currentExpiry && reservationIndex > currentIndex)
      ) {
        ownerByAgent.set(agentId, reservationIndex);
      }
    }
  }

  const leaseUpdatesByReservation = new Map<number, Map<string, number>>();
  const unownedAgentIds: string[] = [];
  for (const agentId of uniqueIncomingAgentIds) {
    const ownerIndex = ownerByAgent.get(agentId);
    if (ownerIndex === undefined) {
      unownedAgentIds.push(agentId);
      continue;
    }
    const owner = reservations[ownerIndex];
    if (owner === undefined) continue;
    let updates = leaseUpdatesByReservation.get(ownerIndex);
    if (updates === undefined) {
      updates = new Map<string, number>();
      leaseUpdatesByReservation.set(ownerIndex, updates);
    }
    updates.set(
      agentId,
      Math.max(
        settlementFamilyAgentLeaseExpiry(owner, agentId),
        settlementFamilyAgentLeaseExpiry(incoming, agentId),
      ),
    );
  }

  const next = reservations.map((reservation, reservationIndex) => {
    const updates = leaseUpdatesByReservation.get(reservationIndex);
    if (updates === undefined || updates.size === 0) return reservation;
    const agentExpiresAtMs = Object.fromEntries(reservation.agentIds.map((agentId) => [
      agentId,
      updates.get(agentId) ?? settlementFamilyAgentLeaseExpiry(reservation, agentId),
    ]));
    return {
      ...reservation,
      agentExpiresAtMs,
      expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),
    };
  });

  if (unownedAgentIds.length === 0) return next;

  const existingIndex = next.findIndex((entry) => entry.reservationId === incoming.reservationId);
  if (existingIndex < 0) {
    const agentExpiresAtMs = Object.fromEntries(unownedAgentIds.map((agentId) => [
      agentId,
      settlementFamilyAgentLeaseExpiry(incoming, agentId),
    ]));
    return [...next, {
      ...incoming,
      agentIds: unownedAgentIds,
      agentExpiresAtMs,
      expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),
    }];
  }

  const existing = next[existingIndex];
  if (existing === undefined) return next;
  const agentIds = [...new Set([...existing.agentIds, ...unownedAgentIds])];
  const unownedSet = new Set(unownedAgentIds);
  const agentExpiresAtMs = Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    unownedSet.has(agentId)
      ? settlementFamilyAgentLeaseExpiry(incoming, agentId)
      : settlementFamilyAgentLeaseExpiry(existing, agentId),
  ]));
  next[existingIndex] = {
    ...existing,
    agentIds,
    agentExpiresAtMs,
    expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),
  };
  return next;
}