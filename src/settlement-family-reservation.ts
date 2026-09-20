export interface SettlementFamilyReleaseWatermark {
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface SettlementFamilyAdmissionReservation {
  reservationId: string;
  sourceRegionId: string;
  pioneerId: string;
  factionId: string;
  agentIds: string[];
  expiresAtMs: number;
  // Wall-clock generation of the registration attempt that produced this
  // reservation. Optional for rolling compatibility with older persisted rows.
  // New writers use it to reject delayed retries from an older attempt even
  // when that request arrives after a newer response and therefore receives a
  // later destination-local lease expiry.
  issuedAtMs?: number;
  // A partial family retry can renew one follower without proving that its
  // siblings belong to the same newer attempt. Persist per-follower generations
  // only when they diverge so releases and delayed retries remain independent.
  // Optional for rolling compatibility; missing entries inherit issuedAtMs.
  agentIssuedAtMs?: Record<string, number>;
  // Per-follower lease expiry lets one retry renew its own capacity promise
  // without keeping canceled siblings reserved for the whole family TTL.
  // Optional for persisted reservations written by older deployments.
  agentExpiresAtMs?: Record<string, number>;
  // A generated release keeps a bounded tombstone after the last live follower
  // leaves the reservation. Without it, deleting the final row also deletes the
  // generation fence and a delayed older registration can resurrect capacity.
  // The watermark expires at the same bounded wall-clock cutoff as the released
  // admission promise, so abandoned route history does not grow without bound.
  releaseWatermarks?: Record<string, SettlementFamilyReleaseWatermark>;
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

function isAgentIssuedAtMap(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.entries(value).every(([agentId, issuedAtMs]) => (
      agentId.length > 0
      && typeof issuedAtMs === "number"
      && Number.isFinite(issuedAtMs)
      && issuedAtMs > 0
    ));
}

function isReleaseWatermarkMap(
  value: unknown,
): value is Record<string, SettlementFamilyReleaseWatermark> {
  return isRecord(value)
    && Object.entries(value).every(([agentId, watermark]) => (
      agentId.length > 0
      && isRecord(watermark)
      && typeof watermark.issuedAtMs === "number"
      && Number.isFinite(watermark.issuedAtMs)
      && watermark.issuedAtMs > 0
      && typeof watermark.expiresAtMs === "number"
      && Number.isFinite(watermark.expiresAtMs)
      && watermark.expiresAtMs > watermark.issuedAtMs
    ));
}

function isReservation(value: unknown): value is SettlementFamilyAdmissionReservation {
  if (!isRecord(value)) return false;
  if (
    typeof value.reservationId !== "string" || value.reservationId.length === 0
    || typeof value.sourceRegionId !== "string" || value.sourceRegionId.length === 0
    || typeof value.pioneerId !== "string" || value.pioneerId.length === 0
    || typeof value.factionId !== "string" || value.factionId.length === 0
    || !Array.isArray(value.agentIds)
    || !value.agentIds.every((agentId) => typeof agentId === "string" && agentId.length > 0)
    || typeof value.expiresAtMs !== "number" || !Number.isFinite(value.expiresAtMs)
    || value.expiresAtMs <= 0
    || (value.issuedAtMs !== undefined && (
      typeof value.issuedAtMs !== "number"
      || !Number.isFinite(value.issuedAtMs)
      || value.issuedAtMs <= 0
    ))
    || (value.agentIssuedAtMs !== undefined && !isAgentIssuedAtMap(value.agentIssuedAtMs))
    || (value.agentExpiresAtMs !== undefined && !isAgentExpiryMap(value.agentExpiresAtMs))
    || (value.releaseWatermarks !== undefined && !isReleaseWatermarkMap(value.releaseWatermarks))
  ) return false;
  return value.agentIds.length > 0
    || (isRecord(value.releaseWatermarks) && Object.keys(value.releaseWatermarks).length > 0);
}

function sameSettlementFamilyReservationIdentity(
  left: SettlementFamilyAdmissionReservation,
  right: SettlementFamilyAdmissionReservation,
): boolean {
  return left.reservationId === right.reservationId
    && left.sourceRegionId === right.sourceRegionId
    && left.pioneerId === right.pioneerId
    && left.factionId === right.factionId;
}

function settlementFamilyReservationIdentityKey(
  reservation: SettlementFamilyAdmissionReservation,
): string {
  return JSON.stringify([
    reservation.reservationId,
    reservation.sourceRegionId,
    reservation.pioneerId,
    reservation.factionId,
  ]);
}

function settlementFamilyReservationIssuedAt(
  reservation: SettlementFamilyAdmissionReservation,
): number {
  const issuedAtMs = reservation.issuedAtMs;
  return typeof issuedAtMs === "number" && Number.isFinite(issuedAtMs) && issuedAtMs > 0
    ? issuedAtMs
    : 0;
}

function settlementFamilyAgentIssuedAt(
  reservation: SettlementFamilyAdmissionReservation,
  agentId: string,
): number {
  const perAgentIssuedAt = reservation.agentIssuedAtMs?.[agentId];
  return typeof perAgentIssuedAt === "number"
    && Number.isFinite(perAgentIssuedAt)
    && perAgentIssuedAt > 0
      ? perAgentIssuedAt
      : settlementFamilyReservationIssuedAt(reservation);
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

function settlementFamilyAggregateExpiry(
  reservation: SettlementFamilyAdmissionReservation,
  agentIds: readonly string[],
  agentExpiresAtMs: Record<string, number> | undefined,
  releaseWatermarks: Record<string, SettlementFamilyReleaseWatermark> | undefined,
): number | undefined {
  const expiries = agentIds.map((agentId) => (
    agentExpiresAtMs?.[agentId] ?? settlementFamilyAgentLeaseExpiry(reservation, agentId)
  ));
  if (releaseWatermarks !== undefined) {
    expiries.push(...Object.values(releaseWatermarks).map((watermark) => watermark.expiresAtMs));
  }
  return expiries.length === 0 ? undefined : Math.max(...expiries);
}

function divergentAgentGenerations(
  agentIds: readonly string[],
  agentIssuedAtMs: Record<string, number>,
  issuedAtMs: number,
): Record<string, number> | undefined {
  return agentIds.every((agentId) => agentIssuedAtMs[agentId] === issuedAtMs)
    ? undefined
    : agentIssuedAtMs;
}

function removeSettlementFamilyReservationAgents(
  reservation: SettlementFamilyAdmissionReservation,
  agentIdsToRemove: ReadonlySet<string>,
): SettlementFamilyAdmissionReservation | undefined {
  const agentIds = reservation.agentIds.filter((agentId) => !agentIdsToRemove.has(agentId));
  const nextAgentIssuedAtMs = agentIds.length === 0 || reservation.agentIssuedAtMs === undefined
    ? undefined
    : Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        settlementFamilyAgentIssuedAt(reservation, agentId),
      ]));
  const agentIssuedAtMs = nextAgentIssuedAtMs === undefined
    ? undefined
    : divergentAgentGenerations(
        agentIds,
        nextAgentIssuedAtMs,
        settlementFamilyReservationIssuedAt(reservation),
      );
  const agentExpiresAtMs = agentIds.length === 0 || reservation.agentExpiresAtMs === undefined
    ? undefined
    : Object.fromEntries(agentIds.map((agentId) => [
        agentId,
        settlementFamilyAgentLeaseExpiry(reservation, agentId),
      ]));
  const expiresAtMs = settlementFamilyAggregateExpiry(
    reservation,
    agentIds,
    agentExpiresAtMs,
    reservation.releaseWatermarks,
  );
  if (expiresAtMs === undefined) return undefined;
  const next = {
    ...reservation,
    agentIds,
    expiresAtMs,
  };
  if (agentIssuedAtMs === undefined) delete next.agentIssuedAtMs;
  else next.agentIssuedAtMs = agentIssuedAtMs;
  if (agentExpiresAtMs === undefined) delete next.agentExpiresAtMs;
  else next.agentExpiresAtMs = agentExpiresAtMs;
  return next;
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
    const normalizedIssuedAtByAgentCandidate = value.agentIssuedAtMs === undefined || pendingAgentIds.length === 0
      ? undefined
      : Object.fromEntries(pendingAgentIds.map((agentId) => [
          agentId,
          settlementFamilyAgentIssuedAt(value, agentId),
        ]));
    const normalizedIssuedAtByAgent = normalizedIssuedAtByAgentCandidate === undefined
      ? undefined
      : divergentAgentGenerations(
          pendingAgentIds,
          normalizedIssuedAtByAgentCandidate,
          settlementFamilyReservationIssuedAt(value),
        );
    const normalizedExpiryByAgent = value.agentExpiresAtMs === undefined || pendingAgentIds.length === 0
      ? undefined
      : Object.fromEntries(pendingAgentIds.map((agentId) => [
          agentId,
          settlementFamilyAgentLeaseExpiry(value, agentId),
        ]));
    const normalizedReleaseWatermarks = value.releaseWatermarks === undefined
      ? undefined
      : Object.fromEntries(Object.entries(value.releaseWatermarks).filter(([, watermark]) => (
          watermark.expiresAtMs > now
        )));
    const liveReleaseWatermarks = normalizedReleaseWatermarks !== undefined
      && Object.keys(normalizedReleaseWatermarks).length > 0
        ? normalizedReleaseWatermarks
        : undefined;
    const expiresAtMs = settlementFamilyAggregateExpiry(
      value,
      pendingAgentIds,
      normalizedExpiryByAgent,
      liveReleaseWatermarks,
    );
    if (expiresAtMs === undefined) {
      changed = true;
      continue;
    }

    const agentGenerationMapChanged = value.agentIssuedAtMs !== undefined && (
      normalizedIssuedAtByAgent === undefined
      || Object.keys(value.agentIssuedAtMs).length !== pendingAgentIds.length
      || pendingAgentIds.some((agentId) =>
        value.agentIssuedAtMs?.[agentId] !== normalizedIssuedAtByAgent[agentId]
      )
    );
    const agentExpiryMapChanged = value.agentExpiresAtMs !== undefined && (
      normalizedExpiryByAgent === undefined
      || Object.keys(value.agentExpiresAtMs).length !== pendingAgentIds.length
      || pendingAgentIds.some((agentId) =>
        value.agentExpiresAtMs?.[agentId] !== normalizedExpiryByAgent[agentId]
      )
    );
    const releaseWatermarksChanged = value.releaseWatermarks !== undefined && (
      liveReleaseWatermarks === undefined
      || Object.keys(value.releaseWatermarks).length !== Object.keys(liveReleaseWatermarks).length
      || Object.entries(liveReleaseWatermarks).some(([agentId, watermark]) => (
        value.releaseWatermarks?.[agentId]?.issuedAtMs !== watermark.issuedAtMs
        || value.releaseWatermarks?.[agentId]?.expiresAtMs !== watermark.expiresAtMs
      ))
    );
    if (
      pendingAgentIds.length !== value.agentIds.length
      || pendingAgentIds.some((agentId, index) => agentId !== value.agentIds[index])
      || expiresAtMs !== value.expiresAtMs
      || agentGenerationMapChanged
      || agentExpiryMapChanged
      || releaseWatermarksChanged
    ) changed = true;
    const normalizedReservation: SettlementFamilyAdmissionReservation = {
      ...value,
      agentIds: pendingAgentIds,
      expiresAtMs,
    };
    if (normalizedIssuedAtByAgent === undefined) delete normalizedReservation.agentIssuedAtMs;
    else normalizedReservation.agentIssuedAtMs = normalizedIssuedAtByAgent;
    if (normalizedExpiryByAgent === undefined) delete normalizedReservation.agentExpiresAtMs;
    else normalizedReservation.agentExpiresAtMs = normalizedExpiryByAgent;
    if (liveReleaseWatermarks === undefined) delete normalizedReservation.releaseWatermarks;
    else normalizedReservation.releaseWatermarks = liveReleaseWatermarks;
    reservations.push(normalizedReservation);
  }

  // A release-only tombstone can legitimately be persisted as a separate row
  // from a stale live row during rolling deployments or recovery. Upsert already
  // consults release watermarks, but ordinary startup normalization used to leave
  // that stale live row untouched because it had no duplicate live owner. Apply
  // the same generation fence across rows of one route identity so a delayed
  // persisted registration cannot resurrect a released capacity slot.
  const strongestReleaseWatermarkByAgent = new Map<string, SettlementFamilyReleaseWatermark>();
  for (const reservation of reservations) {
    const identityKey = settlementFamilyReservationIdentityKey(reservation);
    for (const [agentId, watermark] of Object.entries(reservation.releaseWatermarks ?? {})) {
      const key = `${identityKey}\u0000${agentId}`;
      const current = strongestReleaseWatermarkByAgent.get(key);
      if (
        current === undefined
        || watermark.issuedAtMs > current.issuedAtMs
        || (
          watermark.issuedAtMs === current.issuedAtMs
          && watermark.expiresAtMs > current.expiresAtMs
        )
      ) {
        strongestReleaseWatermarkByAgent.set(key, watermark);
      }
    }
  }

  const releaseFencedReservations = reservations.flatMap((reservation) => {
    if (reservation.agentIds.length === 0) return [reservation];
    const identityKey = settlementFamilyReservationIdentityKey(reservation);
    const staleAgentIds = new Set(reservation.agentIds.filter((agentId) => {
      const watermark = strongestReleaseWatermarkByAgent.get(`${identityKey}\u0000${agentId}`);
      if (watermark === undefined) return false;
      const issuedAtMs = settlementFamilyAgentIssuedAt(reservation, agentId);
      return issuedAtMs === 0 || issuedAtMs <= watermark.issuedAtMs;
    }));
    if (staleAgentIds.size === 0) return [reservation];
    changed = true;
    const trimmed = removeSettlementFamilyReservationAgents(reservation, staleAgentIds);
    return trimmed === undefined ? [] : [trimmed];
  });

  // Rolling deployments can leave duplicate follower ownership persisted by an
  // older writer even after new registrations have switched to single-owner
  // upserts. Repair that state during ordinary normalization instead of waiting
  // for another registration or the 24h TTL. Prefer the strongest still-live
  // per-follower route generation, then per-agent lease; equal leases prefer the
  // later array entry because upserts append the newest owner. Unrelated siblings
  // and any bounded release watermarks stay attached to their original reservation.
  const ownerByAgent = new Map<string, {
    reservationIndex: number;
    issuedAtMs: number;
    expiresAtMs: number;
  }>();
  for (const [reservationIndex, reservation] of releaseFencedReservations.entries()) {
    for (const agentId of reservation.agentIds) {
      const issuedAtMs = settlementFamilyAgentIssuedAt(reservation, agentId);
      const expiresAtMs = settlementFamilyAgentLeaseExpiry(reservation, agentId);
      const current = ownerByAgent.get(agentId);
      if (
        current === undefined
        || issuedAtMs > current.issuedAtMs
        || (issuedAtMs === current.issuedAtMs && expiresAtMs > current.expiresAtMs)
        || (
          issuedAtMs === current.issuedAtMs
          && expiresAtMs === current.expiresAtMs
          && reservationIndex > current.reservationIndex
        )
      ) {
        ownerByAgent.set(agentId, { reservationIndex, issuedAtMs, expiresAtMs });
      }
    }
  }

  const singleOwnerReservations = releaseFencedReservations.flatMap((reservation, reservationIndex) => {
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
  releaseIssuedAtMs?: number,
): SettlementFamilyAdmissionReservation[] {
  // A release can cross a retry that refreshes the same stable follower's
  // admission lease. Fence at the follower lease and follower generation rather
  // than family-wide maxima so renewing one sibling cannot keep another sibling
  // reserved. An exactly equal generation remains concurrent/fail-closed because
  // Date.now() only has millisecond resolution.
  if (agentId.length === 0 || !Number.isFinite(expiresAtCutoffMs)) return [...reservations];
  const releaseGeneration = typeof releaseIssuedAtMs === "number"
    && Number.isFinite(releaseIssuedAtMs)
    && releaseIssuedAtMs > 0
      ? releaseIssuedAtMs
      : undefined;
  return reservations.flatMap((reservation) => {
    const existingWatermark = reservation.releaseWatermarks?.[agentId];
    if (!reservation.agentIds.includes(agentId)) {
      if (
        existingWatermark === undefined
        || releaseGeneration === undefined
        || releaseGeneration <= existingWatermark.issuedAtMs
      ) return [reservation];
      const releaseWatermarks = {
        ...reservation.releaseWatermarks,
        [agentId]: { issuedAtMs: releaseGeneration, expiresAtMs: expiresAtCutoffMs },
      };
      return [{
        ...reservation,
        releaseWatermarks,
        expiresAtMs: Math.max(
          reservation.expiresAtMs,
          ...Object.values(releaseWatermarks).map((watermark) => watermark.expiresAtMs),
        ),
      }];
    }
    const reservationGeneration = settlementFamilyAgentIssuedAt(reservation, agentId);
    if (releaseGeneration !== undefined && reservationGeneration > 0) {
      // When both sides carry generations, compare this follower's route attempt
      // directly. A sibling's later retry is not evidence that this follower was
      // renewed and must not fence its release.
      if (reservationGeneration >= releaseGeneration) return [reservation];
    } else if (settlementFamilyAgentLeaseExpiry(reservation, agentId) >= expiresAtCutoffMs) {
      // Rolling compatibility for legacy reservations/releases without a
      // generation keeps the existing lease-expiry fence.
      return [reservation];
    }

    const withWatermark = releaseGeneration === undefined
      ? reservation
      : {
          ...reservation,
          releaseWatermarks: {
            ...reservation.releaseWatermarks,
            [agentId]: { issuedAtMs: releaseGeneration, expiresAtMs: expiresAtCutoffMs },
          },
        };
    const trimmed = removeSettlementFamilyReservationAgents(
      withWatermark,
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
  const incomingIssuedAtMs = settlementFamilyReservationIssuedAt(incoming);

  // A follower's capacity promise is owned by the reservation that first
  // admitted it. Another pioneer's delayed registration is not evidence that
  // the current route is still alive, so it must neither steal ownership nor
  // refresh the existing lease. Generated retries additionally respect any
  // bounded release watermark retained after a live reservation was removed.
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
      const currentGeneration = settlementFamilyAgentIssuedAt(current, agentId);
      const candidateGeneration = settlementFamilyAgentIssuedAt(reservation, agentId);
      const currentExpiry = settlementFamilyAgentLeaseExpiry(current, agentId);
      const candidateExpiry = settlementFamilyAgentLeaseExpiry(reservation, agentId);
      if (
        candidateGeneration > currentGeneration
        || (candidateGeneration === currentGeneration && candidateExpiry > currentExpiry)
        || (
          candidateGeneration === currentGeneration
          && candidateExpiry === currentExpiry
          && reservationIndex > currentIndex
        )
      ) {
        ownerByAgent.set(agentId, reservationIndex);
      }
    }
  }

  const watermarkByAgent = new Map<string, SettlementFamilyReleaseWatermark>();
  for (const reservation of reservations) {
    if (!sameSettlementFamilyReservationIdentity(reservation, incoming)) continue;
    for (const [agentId, watermark] of Object.entries(reservation.releaseWatermarks ?? {})) {
      const current = watermarkByAgent.get(agentId);
      if (current === undefined || watermark.issuedAtMs > current.issuedAtMs) {
        watermarkByAgent.set(agentId, watermark);
      }
    }
  }

  const leaseUpdatesByReservation = new Map<number, Map<string, {
    expiresAtMs: number;
    issuedAtMs: number;
  }>>();
  const unownedAgentIds: string[] = [];
  for (const agentId of uniqueIncomingAgentIds) {
    const incomingAgentIssuedAtMs = settlementFamilyAgentIssuedAt(incoming, agentId);
    const watermark = watermarkByAgent.get(agentId);
    if (watermark !== undefined && (
      incomingAgentIssuedAtMs === 0 || incomingAgentIssuedAtMs <= watermark.issuedAtMs
    )) continue;

    const ownerIndex = ownerByAgent.get(agentId);
    if (ownerIndex === undefined) {
      unownedAgentIds.push(agentId);
      continue;
    }
    const owner = reservations[ownerIndex];
    if (owner === undefined || !sameSettlementFamilyReservationIdentity(owner, incoming)) continue;
    // Destination receipt time is not a route generation: an old request can
    // arrive late and otherwise receive the newest lease expiry. Compare each
    // follower independently so a newer retry for one sibling does not upgrade
    // another sibling that was absent from that attempt.
    if (incomingAgentIssuedAtMs < settlementFamilyAgentIssuedAt(owner, agentId)) continue;
    let updates = leaseUpdatesByReservation.get(ownerIndex);
    if (updates === undefined) {
      updates = new Map<string, { expiresAtMs: number; issuedAtMs: number }>();
      leaseUpdatesByReservation.set(ownerIndex, updates);
    }
    updates.set(agentId, {
      expiresAtMs: Math.max(
        settlementFamilyAgentLeaseExpiry(owner, agentId),
        settlementFamilyAgentLeaseExpiry(incoming, agentId),
      ),
      issuedAtMs: Math.max(
        settlementFamilyAgentIssuedAt(owner, agentId),
        incomingAgentIssuedAtMs,
      ),
    });
  }

  const next = reservations.map((reservation, reservationIndex) => {
    const updates = leaseUpdatesByReservation.get(reservationIndex);
    if (updates === undefined || updates.size === 0) return reservation;
    const agentExpiresAtMs = Object.fromEntries(reservation.agentIds.map((agentId) => [
      agentId,
      updates.get(agentId)?.expiresAtMs ?? settlementFamilyAgentLeaseExpiry(reservation, agentId),
    ]));
    const nextAgentIssuedAtMs = Object.fromEntries(reservation.agentIds.map((agentId) => [
      agentId,
      updates.get(agentId)?.issuedAtMs ?? settlementFamilyAgentIssuedAt(reservation, agentId),
    ]));
    const issuedAtMs = Math.max(
      settlementFamilyReservationIssuedAt(reservation),
      incomingIssuedAtMs,
      ...Object.values(nextAgentIssuedAtMs),
    );
    const agentIssuedAtMs = divergentAgentGenerations(
      reservation.agentIds,
      nextAgentIssuedAtMs,
      issuedAtMs,
    );
    const releaseWatermarks = reservation.releaseWatermarks === undefined
      ? undefined
      : Object.fromEntries(Object.entries(reservation.releaseWatermarks).filter(([agentId]) => (
          !updates.has(agentId)
        )));
    const liveReleaseWatermarks = releaseWatermarks !== undefined
      && Object.keys(releaseWatermarks).length > 0
        ? releaseWatermarks
        : undefined;
    const expiresAtMs = settlementFamilyAggregateExpiry(
      reservation,
      reservation.agentIds,
      agentExpiresAtMs,
      liveReleaseWatermarks,
    );
    const updated: SettlementFamilyAdmissionReservation = {
      ...reservation,
      ...(issuedAtMs > 0 ? { issuedAtMs } : {}),
      agentExpiresAtMs,
      expiresAtMs: expiresAtMs ?? reservation.expiresAtMs,
    };
    if (agentIssuedAtMs === undefined) delete updated.agentIssuedAtMs;
    else updated.agentIssuedAtMs = agentIssuedAtMs;
    if (liveReleaseWatermarks === undefined) delete updated.releaseWatermarks;
    else updated.releaseWatermarks = liveReleaseWatermarks;
    return updated;
  });

  if (unownedAgentIds.length === 0) return next;

  const existingIndex = next.findIndex((entry) => entry.reservationId === incoming.reservationId);
  if (existingIndex < 0) {
    const agentExpiresAtMs = Object.fromEntries(unownedAgentIds.map((agentId) => [
      agentId,
      settlementFamilyAgentLeaseExpiry(incoming, agentId),
    ]));
    const nextAgentIssuedAtMs = Object.fromEntries(unownedAgentIds.map((agentId) => [
      agentId,
      settlementFamilyAgentIssuedAt(incoming, agentId),
    ]));
    const issuedAtMs = Math.max(incomingIssuedAtMs, ...Object.values(nextAgentIssuedAtMs));
    const agentIssuedAtMs = divergentAgentGenerations(
      unownedAgentIds,
      nextAgentIssuedAtMs,
      issuedAtMs,
    );
    const created: SettlementFamilyAdmissionReservation = {
      ...incoming,
      ...(issuedAtMs > 0 ? { issuedAtMs } : {}),
      agentIds: unownedAgentIds,
      agentExpiresAtMs,
      expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),
    };
    if (agentIssuedAtMs === undefined) delete created.agentIssuedAtMs;
    else created.agentIssuedAtMs = agentIssuedAtMs;
    delete created.releaseWatermarks;
    return [...next, created];
  }

  const existing = next[existingIndex];
  // A reservationId collision with different source/pioneer/faction metadata is
  // ambiguous persisted/input state. Do not attach newly unowned followers to
  // it; normalization/TTL can repair or retire the old record safely.
  if (existing === undefined || !sameSettlementFamilyReservationIdentity(existing, incoming)) return next;
  if (incomingIssuedAtMs < settlementFamilyReservationIssuedAt(existing)) return next;
  const agentIds = [...new Set([...existing.agentIds, ...unownedAgentIds])];
  const unownedSet = new Set(unownedAgentIds);
  const agentExpiresAtMs = Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    unownedSet.has(agentId)
      ? settlementFamilyAgentLeaseExpiry(incoming, agentId)
      : settlementFamilyAgentLeaseExpiry(existing, agentId),
  ]));
  const nextAgentIssuedAtMs = Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    unownedSet.has(agentId)
      ? settlementFamilyAgentIssuedAt(incoming, agentId)
      : settlementFamilyAgentIssuedAt(existing, agentId),
  ]));
  const issuedAtMs = Math.max(
    settlementFamilyReservationIssuedAt(existing),
    incomingIssuedAtMs,
    ...Object.values(nextAgentIssuedAtMs),
  );
  const agentIssuedAtMs = divergentAgentGenerations(
    agentIds,
    nextAgentIssuedAtMs,
    issuedAtMs,
  );
  const releaseWatermarks = existing.releaseWatermarks === undefined
    ? undefined
    : Object.fromEntries(Object.entries(existing.releaseWatermarks).filter(([agentId]) => (
        !unownedSet.has(agentId)
      )));
  const liveReleaseWatermarks = releaseWatermarks !== undefined
    && Object.keys(releaseWatermarks).length > 0
      ? releaseWatermarks
      : undefined;
  const expiresAtMs = settlementFamilyAggregateExpiry(
    existing,
    agentIds,
    agentExpiresAtMs,
    liveReleaseWatermarks,
  );
  next[existingIndex] = {
    ...existing,
    ...(issuedAtMs > 0 ? { issuedAtMs } : {}),
    agentIds,
    agentExpiresAtMs,
    expiresAtMs: expiresAtMs ?? existing.expiresAtMs,
  };
  if (agentIssuedAtMs === undefined) delete next[existingIndex].agentIssuedAtMs;
  else next[existingIndex].agentIssuedAtMs = agentIssuedAtMs;
  if (liveReleaseWatermarks === undefined) delete next[existingIndex].releaseWatermarks;
  else next[existingIndex].releaseWatermarks = liveReleaseWatermarks;
  return next;
}