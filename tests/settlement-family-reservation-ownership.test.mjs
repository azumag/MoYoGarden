import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSettlementFamilyAdmissionReservations,
  releaseSettlementFamilyAdmissionAgent,
  settlementFamilyReservedSlots,
  upsertSettlementFamilyAdmissionReservation,
} from "../dist-ts/src/settlement-family-reservation.js";

const follower = "agent-global:garden-1:follower";
const sibling = "agent-global:garden-1:sibling";
const newcomer = "agent-global:garden-1:newcomer";

function reservation({
  reservationId,
  pioneerId,
  agentIds,
  expiresAtMs,
  agentExpiresAtMs,
  sourceRegionId = "garden-1",
  factionId = "faction-a",
}) {
  return {
    reservationId,
    sourceRegionId,
    pioneerId,
    factionId,
    agentIds,
    expiresAtMs,
    ...(agentExpiresAtMs === undefined ? {} : { agentExpiresAtMs }),
  };
}

test("another pioneer retry cannot refresh or replace the follower reservation owner", () => {
  const existing = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower, sibling],
    expiresAtMs: 240,
    agentExpiresAtMs: {
      [follower]: 240,
      [sibling]: 210,
    },
  });
  const incoming = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    agentIds: [follower],
    expiresAtMs: 300,
  });

  const next = upsertSettlementFamilyAdmissionReservation([existing], incoming);

  assert.equal(next.length, 1, "a retry must not create a second reservation owner for the follower");
  assert.equal(next[0]?.reservationId, existing.reservationId);
  assert.deepEqual(next[0]?.agentIds, [follower, sibling]);
  assert.deepEqual(next[0]?.agentExpiresAtMs, {
    [follower]: 240,
    [sibling]: 210,
  });
  assert.equal(next[0]?.expiresAtMs, 240);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 2);
});

test("an idempotent retry from the same reservation can renew its follower lease", () => {
  const existing = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower, sibling],
    expiresAtMs: 240,
    agentExpiresAtMs: {
      [follower]: 240,
      [sibling]: 210,
    },
  });
  const incoming = reservation({
    reservationId: existing.reservationId,
    pioneerId: existing.pioneerId,
    agentIds: [follower],
    expiresAtMs: 300,
  });

  const next = upsertSettlementFamilyAdmissionReservation([existing], incoming);

  assert.equal(next.length, 1);
  assert.deepEqual(next[0]?.agentExpiresAtMs, {
    [follower]: 300,
    [sibling]: 210,
  });
  assert.equal(next[0]?.expiresAtMs, 300);
});

test("a retry can still reserve an unowned follower while keeping an existing owner and lease stable", () => {
  const existing = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower],
    expiresAtMs: 240,
  });
  const incoming = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    agentIds: [follower, newcomer],
    expiresAtMs: 300,
  });

  const next = upsertSettlementFamilyAdmissionReservation([existing], incoming);

  const oldOwner = next.find((entry) => entry.reservationId === existing.reservationId);
  const newOwner = next.find((entry) => entry.reservationId === incoming.reservationId);
  assert.deepEqual(oldOwner?.agentIds, [follower]);
  assert.equal(oldOwner?.agentExpiresAtMs, undefined);
  assert.equal(oldOwner?.expiresAtMs, 240);
  assert.deepEqual(newOwner?.agentIds, [newcomer]);
  assert.equal(newOwner?.agentExpiresAtMs?.[newcomer], 300);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 2);
});

test("a reservationId collision with different route metadata cannot absorb an unowned follower", () => {
  const existing = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower],
    expiresAtMs: 240,
  });
  const conflicting = reservation({
    reservationId: existing.reservationId,
    pioneerId: "pioneer-b",
    agentIds: [newcomer],
    expiresAtMs: 300,
  });

  const next = upsertSettlementFamilyAdmissionReservation([existing], conflicting);

  assert.deepEqual(next, [existing]);
});

test("normalization repairs duplicate follower ownership left by older writers", () => {
  const oldOwner = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower, sibling],
    expiresAtMs: 260,
    agentExpiresAtMs: {
      [follower]: 240,
      [sibling]: 260,
    },
  });
  const newerOwner = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    agentIds: [follower],
    expiresAtMs: 300,
  });

  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [oldOwner, newerOwner],
    new Set(),
    100,
  );

  assert.equal(normalized.changed, true);
  assert.equal(
    normalized.reservations.flatMap((entry) => entry.agentIds)
      .filter((agentId) => agentId === follower).length,
    1,
  );
  const repairedOldOwner = normalized.reservations.find(
    (entry) => entry.reservationId === oldOwner.reservationId,
  );
  assert.deepEqual(repairedOldOwner?.agentIds, [sibling]);
  assert.equal(repairedOldOwner?.expiresAtMs, 260);
  assert.deepEqual(repairedOldOwner?.agentExpiresAtMs, { [sibling]: 260 });
  const repairedNewOwner = normalized.reservations.find(
    (entry) => entry.reservationId === newerOwner.reservationId,
  );
  assert.equal(repairedNewOwner?.expiresAtMs, 300);
  assert.equal(
    repairedNewOwner?.agentExpiresAtMs,
    undefined,
    "legacy reservations should keep using family-wide expiry as the per-agent fallback",
  );
});

test("normalization persists repaired per-agent lease membership when key count is unchanged", () => {
  const stored = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower, sibling],
    expiresAtMs: 300,
    agentExpiresAtMs: {
      [follower]: 240,
      [newcomer]: 300,
    },
  });

  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [stored],
    new Set(),
    100,
  );

  assert.equal(
    normalized.changed,
    true,
    "a same-size lease map with the wrong follower key must be written back",
  );
  assert.deepEqual(normalized.reservations[0]?.agentExpiresAtMs, {
    [follower]: 240,
    [sibling]: 300,
  });
  assert.equal(normalized.reservations[0]?.expiresAtMs, 300);
});

test("normalization resolves equal legacy leases to the later appended owner", () => {
  const first = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower],
    expiresAtMs: 300,
  });
  const second = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    agentIds: [follower],
    expiresAtMs: 300,
  });

  const normalized = normalizeSettlementFamilyAdmissionReservations(
    [first, second],
    new Set(),
    100,
  );

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.reservations.map((entry) => entry.reservationId), [second.reservationId]);
});

test("stale retry from another pioneer cannot keep an obsolete follower lease alive", () => {
  const oldOwner = reservation({
    reservationId: "family:garden-1:pioneer-a:hex-q1-r0",
    pioneerId: "pioneer-a",
    agentIds: [follower],
    expiresAtMs: 240,
  });
  const incoming = reservation({
    reservationId: "family:garden-1:pioneer-b:hex-q1-r0",
    pioneerId: "pioneer-b",
    agentIds: [follower],
    expiresAtMs: 300,
  });

  const unchanged = upsertSettlementFamilyAdmissionReservation([oldOwner], incoming);
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0]?.reservationId, oldOwner.reservationId);
  assert.equal(unchanged[0]?.expiresAtMs, 240);

  const afterConcurrentRelease = releaseSettlementFamilyAdmissionAgent(unchanged, follower, 240);
  assert.equal(afterConcurrentRelease.length, 1, "an equal cutoff is ambiguous and must preserve the current lease");

  const afterCurrentRelease = releaseSettlementFamilyAdmissionAgent(unchanged, follower, 241);
  assert.deepEqual(afterCurrentRelease, []);
});