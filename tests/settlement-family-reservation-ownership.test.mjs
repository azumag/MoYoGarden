import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseSettlementFamilyAdmissionAgent,
  settlementFamilyReservedSlots,
  upsertSettlementFamilyAdmissionReservation,
} from "../dist-ts/src/settlement-family-reservation.js";

const follower = "agent-global:garden-1:follower";
const sibling = "agent-global:garden-1:sibling";

function reservation({
  reservationId,
  pioneerId,
  agentIds,
  expiresAtMs,
  agentExpiresAtMs,
}) {
  return {
    reservationId,
    sourceRegionId: "garden-1",
    pioneerId,
    factionId: "faction-a",
    agentIds,
    expiresAtMs,
    ...(agentExpiresAtMs === undefined ? {} : { agentExpiresAtMs }),
  };
}

test("new family registration gives each follower one authoritative reservation owner", () => {
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

  assert.equal(
    next.flatMap((entry) => entry.agentIds).filter((agentId) => agentId === follower).length,
    1,
    "the same stable follower must not remain owned by two pioneer reservations",
  );
  const oldOwner = next.find((entry) => entry.reservationId === existing.reservationId);
  assert.deepEqual(oldOwner?.agentIds, [sibling]);
  assert.equal(oldOwner?.expiresAtMs, 210, "removing the moved follower should recompute sibling lease expiry");
  assert.deepEqual(oldOwner?.agentExpiresAtMs, { [sibling]: 210 });
  const newOwner = next.find((entry) => entry.reservationId === incoming.reservationId);
  assert.deepEqual(newOwner?.agentIds, [follower]);
  assert.equal(newOwner?.agentExpiresAtMs?.[follower], 300);
  assert.equal(settlementFamilyReservedSlots(next, "faction-a"), 2);
});

test("stale release from the previous pioneer cannot delete the newer follower lease", () => {
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

  const rerouted = upsertSettlementFamilyAdmissionReservation([oldOwner], incoming);
  assert.equal(rerouted.length, 1, "the old empty reservation should be removed during ownership transfer");
  assert.equal(rerouted[0]?.reservationId, incoming.reservationId);

  const afterStaleRelease = releaseSettlementFamilyAdmissionAgent(rerouted, follower, 240);
  assert.equal(afterStaleRelease.length, 1);
  assert.deepEqual(afterStaleRelease[0]?.agentIds, [follower]);

  const afterCurrentRelease = releaseSettlementFamilyAdmissionAgent(rerouted, follower, 300);
  assert.deepEqual(afterCurrentRelease, []);
});
