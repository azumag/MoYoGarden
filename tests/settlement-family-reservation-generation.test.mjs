import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeSettlementFamilyAdmissionReservations,
  releaseSettlementFamilyAdmissionAgent,
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

test("the first generated retry upgrades a legacy reservation without a generation", () => {
  const legacy = reservation({
    expiresAtMs: 300,
    agentExpiresAtMs: { [follower]: 300 },
  });
  const generated = reservation({
    issuedAtMs: 400,
    expiresAtMs: 500,
  });

  const next = upsertSettlementFamilyAdmissionReservation([legacy], generated);

  assert.equal(next[0]?.issuedAtMs, 400);
  assert.equal(next[0]?.agentExpiresAtMs?.[follower], 500);
  assert.equal(next[0]?.expiresAtMs, 500);
});

test("a newer release cancels an older generated reservation despite a late receipt lease", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);

  assert.deepEqual(next, []);
});

test("a stale release cannot cancel a newer generated reservation", () => {
  const current = reservation({
    issuedAtMs: 300,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 900, 200);

  assert.deepEqual(next, [current]);
});

test("same-millisecond registration and release keep the reservation fail-closed", () => {
  const current = reservation({
    issuedAtMs: 300,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 900, 300);

  assert.deepEqual(next, [current]);
});

test("legacy release ordering keeps the lease-expiry fence when generation is absent", () => {
  const legacy = reservation({
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500 },
  });

  assert.deepEqual(
    releaseSettlementFamilyAdmissionAgent([legacy], follower, 500, 300),
    [legacy],
    "equal legacy cutoff remains fail-closed",
  );
  assert.deepEqual(
    releaseSettlementFamilyAdmissionAgent([legacy], follower, 501, 300),
    [],
    "legacy reservations still release once the lease is definitely older",
  );
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
  assert.match(
    source,
    /releaseSettlementFamilyAdmissionAgent\([\s\S]*?reservationExpiresAtCutoffMs,[\s\S]*?body\.releaseIssuedAtMs as number,[\s\S]*?\);/,
  );
});
