import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeSettlementFamilyAdmissionReservations,
  releaseSettlementFamilyAdmissionAgent,
  settlementFamilyReservedSlots,
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

test("a newer release cancels an older generated reservation and leaves a bounded watermark", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });

  const next = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);

  assert.equal(next.length, 1);
  assert.deepEqual(next[0]?.agentIds, []);
  assert.deepEqual(next[0]?.releaseWatermarks, {
    [follower]: { issuedAtMs: 300, expiresAtMs: 500 },
  });
  assert.equal(next[0]?.expiresAtMs, 500);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 0);
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
    releaseSettlementFamilyAdmissionAgent([legacy], follower, 501),
    [],
    "legacy releases without a generation keep the old delete behavior",
  );
});

test("a delayed registration cannot resurrect a follower after a newer generated release", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });
  const released = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);
  const delayedOlder = reservation({
    issuedAtMs: 200,
    expiresAtMs: 900,
  });

  const next = upsertSettlementFamilyAdmissionReservation(released, delayedOlder);

  assert.deepEqual(next, released);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 0);
});

test("a registration newer than the release watermark can reserve the follower again", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });
  const released = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);
  const newer = reservation({
    issuedAtMs: 400,
    expiresAtMs: 900,
  });

  const next = upsertSettlementFamilyAdmissionReservation(released, newer);

  assert.equal(next.length, 1);
  assert.deepEqual(next[0]?.agentIds, [follower]);
  assert.equal(next[0]?.issuedAtMs, 400);
  assert.equal(next[0]?.agentExpiresAtMs?.[follower], 900);
  assert.equal(next[0]?.releaseWatermarks, undefined);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 1);
});

test("release-only tombstones expire during normalization", () => {
  const current = reservation({
    issuedAtMs: 200,
    expiresAtMs: 800,
    agentExpiresAtMs: { [follower]: 800 },
  });
  const released = releaseSettlementFamilyAdmissionAgent([current], follower, 500, 300);

  const stillBounded = normalizeSettlementFamilyAdmissionReservations(released, new Set(), 499);
  assert.equal(stillBounded.reservations.length, 1);
  assert.equal(stillBounded.reservations[0]?.agentIds.length, 0);

  const expired = normalizeSettlementFamilyAdmissionReservations(released, new Set(), 500);
  assert.equal(expired.changed, true);
  assert.deepEqual(expired.reservations, []);
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

test("a retry for one sibling does not advance another sibling's release generation", () => {
  const current = reservation({
    agentIds: [follower, newcomer],
    issuedAtMs: 200,
    expiresAtMs: 500,
    agentExpiresAtMs: { [follower]: 500, [newcomer]: 500 },
  });
  const followerRetry = reservation({
    agentIds: [follower],
    issuedAtMs: 400,
    expiresAtMs: 900,
  });

  const renewed = upsertSettlementFamilyAdmissionReservation([current], followerRetry);

  assert.equal(renewed[0]?.issuedAtMs, 400);
  assert.deepEqual(renewed[0]?.agentIssuedAtMs, {
    [follower]: 400,
    [newcomer]: 200,
  });

  const released = releaseSettlementFamilyAdmissionAgent(renewed, newcomer, 800, 300);

  assert.deepEqual(released[0]?.agentIds, [follower]);
  assert.equal(released[0]?.agentExpiresAtMs?.[follower], 900);
  assert.deepEqual(released[0]?.releaseWatermarks?.[newcomer], {
    issuedAtMs: 300,
    expiresAtMs: 800,
  });
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
