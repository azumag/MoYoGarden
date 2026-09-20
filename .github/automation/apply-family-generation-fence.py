from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


reservation_path = Path("src/settlement-family-reservation.ts")
text = reservation_path.read_text()

text = replace_once(
    text,
    """  expiresAtMs: number;\n  // Per-follower lease expiry lets one retry renew its own capacity promise\n""",
    """  expiresAtMs: number;\n  // Wall-clock generation of the registration attempt that produced this\n  // reservation. Optional for rolling compatibility with older persisted rows.\n  // New writers use it to reject delayed retries from an older attempt even\n  // when that request arrives after a newer response and therefore receives a\n  // later destination-local lease expiry.\n  issuedAtMs?: number;\n  // Per-follower lease expiry lets one retry renew its own capacity promise\n""",
    "reservation interface",
)

text = replace_once(
    text,
    """    && typeof value.expiresAtMs === \"number\" && Number.isFinite(value.expiresAtMs)\n    && value.expiresAtMs > 0\n    && (value.agentExpiresAtMs === undefined || isAgentExpiryMap(value.agentExpiresAtMs));\n""",
    """    && typeof value.expiresAtMs === \"number\" && Number.isFinite(value.expiresAtMs)\n    && value.expiresAtMs > 0\n    && (value.issuedAtMs === undefined || (\n      typeof value.issuedAtMs === \"number\"\n      && Number.isFinite(value.issuedAtMs)\n      && value.issuedAtMs > 0\n    ))\n    && (value.agentExpiresAtMs === undefined || isAgentExpiryMap(value.agentExpiresAtMs));\n""",
    "reservation validation",
)

text = replace_once(
    text,
    """function settlementFamilyAgentLeaseExpiry(\n  reservation: SettlementFamilyAdmissionReservation,\n  agentId: string,\n): number {\n""",
    """function settlementFamilyReservationIssuedAt(\n  reservation: SettlementFamilyAdmissionReservation,\n): number {\n  const issuedAtMs = reservation.issuedAtMs;\n  return typeof issuedAtMs === \"number\" && Number.isFinite(issuedAtMs) && issuedAtMs > 0\n    ? issuedAtMs\n    : 0;\n}\n\nfunction settlementFamilyAgentLeaseExpiry(\n  reservation: SettlementFamilyAdmissionReservation,\n  agentId: string,\n): number {\n""",
    "issued-at helper",
)

text = replace_once(
    text,
    """  const ownerByAgent = new Map<string, { reservationIndex: number; expiresAtMs: number }>();\n  for (const [reservationIndex, reservation] of reservations.entries()) {\n    for (const agentId of reservation.agentIds) {\n      const expiresAtMs = settlementFamilyAgentLeaseExpiry(reservation, agentId);\n      const current = ownerByAgent.get(agentId);\n      if (\n        current === undefined\n        || expiresAtMs > current.expiresAtMs\n        || (expiresAtMs === current.expiresAtMs && reservationIndex > current.reservationIndex)\n      ) {\n        ownerByAgent.set(agentId, { reservationIndex, expiresAtMs });\n      }\n    }\n  }\n""",
    """  const ownerByAgent = new Map<string, {\n    reservationIndex: number;\n    issuedAtMs: number;\n    expiresAtMs: number;\n  }>();\n  for (const [reservationIndex, reservation] of reservations.entries()) {\n    for (const agentId of reservation.agentIds) {\n      const issuedAtMs = settlementFamilyReservationIssuedAt(reservation);\n      const expiresAtMs = settlementFamilyAgentLeaseExpiry(reservation, agentId);\n      const current = ownerByAgent.get(agentId);\n      if (\n        current === undefined\n        || issuedAtMs > current.issuedAtMs\n        || (issuedAtMs === current.issuedAtMs && expiresAtMs > current.expiresAtMs)\n        || (\n          issuedAtMs === current.issuedAtMs\n          && expiresAtMs === current.expiresAtMs\n          && reservationIndex > current.reservationIndex\n        )\n      ) {\n        ownerByAgent.set(agentId, { reservationIndex, issuedAtMs, expiresAtMs });\n      }\n    }\n  }\n""",
    "normalization ownership ordering",
)

text = replace_once(
    text,
    """  const uniqueIncomingAgentIds = [...new Set(incoming.agentIds)];\n\n  // A follower's capacity promise is owned by the reservation that first\n""",
    """  const uniqueIncomingAgentIds = [...new Set(incoming.agentIds)];\n  const incomingIssuedAtMs = settlementFamilyReservationIssuedAt(incoming);\n\n  // A follower's capacity promise is owned by the reservation that first\n""",
    "incoming generation",
)

text = replace_once(
    text,
    """    const owner = reservations[ownerIndex];\n    if (owner === undefined || !sameSettlementFamilyReservationIdentity(owner, incoming)) continue;\n    let updates = leaseUpdatesByReservation.get(ownerIndex);\n""",
    """    const owner = reservations[ownerIndex];\n    if (owner === undefined || !sameSettlementFamilyReservationIdentity(owner, incoming)) continue;\n    // Destination receipt time is not a route generation: an old request can\n    // arrive late and otherwise receive the newest lease expiry. Once both\n    // sides carry issuedAtMs, only the same or a newer registration attempt may\n    // renew an already-owned follower. Legacy rows/requests both map to zero so\n    // rolling deployments keep their previous idempotent behavior.\n    if (incomingIssuedAtMs < settlementFamilyReservationIssuedAt(owner)) continue;\n    let updates = leaseUpdatesByReservation.get(ownerIndex);\n""",
    "owned follower generation fence",
)

text = replace_once(
    text,
    """    return {\n      ...reservation,\n      agentExpiresAtMs,\n      expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),\n    };\n""",
    """    const issuedAtMs = Math.max(\n      settlementFamilyReservationIssuedAt(reservation),\n      incomingIssuedAtMs,\n    );\n    return {\n      ...reservation,\n      ...(issuedAtMs > 0 ? { issuedAtMs } : {}),\n      agentExpiresAtMs,\n      expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),\n    };\n""",
    "owner generation persistence",
)

text = replace_once(
    text,
    """  if (existing === undefined || !sameSettlementFamilyReservationIdentity(existing, incoming)) return next;\n  const agentIds = [...new Set([...existing.agentIds, ...unownedAgentIds])];\n""",
    """  if (existing === undefined || !sameSettlementFamilyReservationIdentity(existing, incoming)) return next;\n  if (incomingIssuedAtMs < settlementFamilyReservationIssuedAt(existing)) return next;\n  const agentIds = [...new Set([...existing.agentIds, ...unownedAgentIds])];\n""",
    "unowned follower generation fence",
)

text = replace_once(
    text,
    """  next[existingIndex] = {\n    ...existing,\n    agentIds,\n    agentExpiresAtMs,\n    expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),\n  };\n""",
    """  const issuedAtMs = Math.max(\n    settlementFamilyReservationIssuedAt(existing),\n    incomingIssuedAtMs,\n  );\n  next[existingIndex] = {\n    ...existing,\n    ...(issuedAtMs > 0 ? { issuedAtMs } : {}),\n    agentIds,\n    agentExpiresAtMs,\n    expiresAtMs: Math.max(...Object.values(agentExpiresAtMs)),\n  };\n""",
    "merged reservation generation persistence",
)

reservation_path.write_text(text)

autonomy_path = Path("src/autonomy-region.ts")
autonomy = autonomy_path.read_text()
autonomy = replace_once(
    autonomy,
    """private async reserveSettlementFamilyAdmissions(\n  state: WorldState,\n  sourceRegionId: string,\n  pioneerId: string,\n  factionId: string,\n  sourceAgentIds: readonly string[],\n): Promise<void> {\n""",
    """private async reserveSettlementFamilyAdmissions(\n  state: WorldState,\n  sourceRegionId: string,\n  pioneerId: string,\n  factionId: string,\n  sourceAgentIds: readonly string[],\n  registrationIssuedAtMs: number,\n): Promise<void> {\n""",
    "reserve signature",
)
autonomy = replace_once(
    autonomy,
    """  const reservationId = `family:${sourceRegionId}:${pioneerId}:${state.regionId}`;\n  const now = Date.now();\n  await this.autonomyState.blockConcurrencyWhile(async () => {\n""",
    """  const reservationId = `family:${sourceRegionId}:${pioneerId}:${state.regionId}`;\n  const now = Date.now();\n  const issuedAtMs = Number.isFinite(registrationIssuedAtMs) && registrationIssuedAtMs > 0\n    ? registrationIssuedAtMs\n    : now;\n  await this.autonomyState.blockConcurrencyWhile(async () => {\n""",
    "reserve generation sanitize",
)
autonomy = replace_once(
    autonomy,
    """        factionId,\n        agentIds,\n        expiresAtMs: now + SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS,\n""",
    """        factionId,\n        agentIds,\n        issuedAtMs,\n        expiresAtMs: now + SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS,\n""",
    "reserve generation write",
)
autonomy = replace_once(
    autonomy,
    """      if (familyAdmissionHeadroom <= 0) continue;\n      try {\n        const response = await this.autonomyStub(sourceRegionId).fetch(new Request(\n""",
    """      if (familyAdmissionHeadroom <= 0) continue;\n      const registrationIssuedAtMs = Date.now();\n      try {\n        const response = await this.autonomyStub(sourceRegionId).fetch(new Request(\n""",
    "registration generation issue",
)
autonomy = replace_once(
    autonomy,
    """    pioneer.factionId,\n    registeredAgentIds,\n  );\n""",
    """    pioneer.factionId,\n    registeredAgentIds,\n    registrationIssuedAtMs,\n  );\n""",
    "registration generation handoff",
)
autonomy_path.write_text(autonomy)

test_path = Path("tests/settlement-family-reservation-generation.test.mjs")
test_path.write_text(r'''import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeSettlementFamilyAdmissionReservations,
  upsertSettlementFamilyAdmissionReservation,
} from "../dist-ts/src/settlement-family-reservation.js";

const follower = "agent-global:garden-1:follower";
const newcomer = "agent-global:garden-1:newcomer";

function reservation(overrides = {}) {
  return {
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    sourceRegionId: "garden-1",
    pioneerId: "pioneer-a",
    factionId: "faction-a",
    agentIds: [follower],
    expiresAtMs: 300,
    ...overrides,
  };
}

test("an older same-route registration cannot renew a newer follower lease", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 300,
    agentExpiresAtMs: { [follower]: 300 },
  });
  const delayedOlder = reservation({
    issuedAtMs: 100,
    expiresAtMs: 500,
  });

  const next = upsertSettlementFamilyAdmissionReservation([current], delayedOlder);

  assert.deepEqual(next, [current]);
});

test("a newer same-route registration renews the lease and advances its generation", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 300,
    agentExpiresAtMs: { [follower]: 300 },
  });
  const newer = reservation({
    issuedAtMs: 400,
    expiresAtMs: 500,
  });

  const next = upsertSettlementFamilyAdmissionReservation([current], newer);

  assert.equal(next[0]?.issuedAtMs, 400);
  assert.equal(next[0]?.agentExpiresAtMs?.[follower], 500);
  assert.equal(next[0]?.expiresAtMs, 500);
});

test("an older same-route response cannot append a follower absent from the newer attempt", () => {
  const current = reservation({
    issuedAtMs: 400,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });
  const delayedOlder = reservation({
    issuedAtMs: 200,
    agentIds: [newcomer],
    expiresAtMs: 700,
  });

  const next = upsertSettlementFamilyAdmissionReservation([current], delayedOlder);

  assert.deepEqual(next, [current]);
});

test("duplicate repair prefers route generation over a later destination lease", () => {
  const newerGeneration = reservation({
    issuedAtMs: 400,
    expiresAtMs: 500,
  });
  const delayedOlderGeneration = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    issuedAtMs: 200,
    expiresAtMs: 700,
  });

  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [newerGeneration, delayedOlderGeneration],
    new Set(),
    100,
  );

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.reservations.map((entry) => entry.reservationId), [newerGeneration.reservationId]);
});

test("the destination issues registration generation before the cross-region request and persists it", () => {
  const source = readFileSync(new URL("../src/autonomy-region.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const registrationIssuedAtMs = Date\.now\(\);[\s\S]*?INTERNAL_SETTLEMENT_FAMILY_REGISTER_PATH/,
  );
  assert.match(
    source,
    /reserveSettlementFamilyAdmissions\([\s\S]*?registeredAgentIds,[\s\S]*?registrationIssuedAtMs,[\s\S]*?\);/,
  );
  assert.match(
    source,
    /issuedAtMs,[\s\S]*?expiresAtMs: now \+ SETTLEMENT_FAMILY_ADMISSION_RESERVATION_TTL_MS/,
  );
});
''')
