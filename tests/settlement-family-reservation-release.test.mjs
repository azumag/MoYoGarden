import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseSettlementFamilyAdmissionAgent,
  upsertSettlementFamilyAdmissionReservation,
} from "../dist-ts/src/settlement-family-reservation.js";

const OLD_EXPIRY = 2_000_000_000_000;
const AFTER_OLD_EXPIRY = OLD_EXPIRY + 1;

function reservation(id, agentIds, expiresAtMs = OLD_EXPIRY, agentExpiresAtMs) {
  return {
    reservationId: id,
    sourceRegionId: "garden-1",
    pioneerId: "agent-global:garden-1:pioneer",
    factionId: "faction-1",
    agentIds,
    expiresAtMs,
    ...(agentExpiresAtMs === undefined ? {} : { agentExpiresAtMs }),
  };
}

test("family admission release removes only the abandoned follower slot", () => {
  const abandoned = "agent-global:garden-1:child";
  const partner = "agent-global:garden-1:partner";
  const next = releaseSettlementFamilyAdmissionAgent(
    [reservation("family:1", [abandoned, partner])],
    abandoned,
    AFTER_OLD_EXPIRY,
  );
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].agentIds, [partner]);
});

test("family admission release drops an empty reservation and is idempotent", () => {
  const abandoned = "agent-global:garden-1:child";
  const first = releaseSettlementFamilyAdmissionAgent(
    [reservation("family:1", [abandoned])],
    abandoned,
    AFTER_OLD_EXPIRY,
  );
  assert.deepEqual(first, []);
  assert.deepEqual(
    releaseSettlementFamilyAdmissionAgent(first, abandoned, AFTER_OLD_EXPIRY),
    [],
  );
});

test("family admission release clears duplicate stale promises without touching other followers", () => {
  const abandoned = "agent-global:garden-1:child";
  const other = "agent-global:garden-1:other";
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:1", [abandoned, other]),
    reservation("family:2", [abandoned]),
  ], abandoned, AFTER_OLD_EXPIRY);
  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:1");
  assert.deepEqual(next[0].agentIds, [other]);
});

test("a delayed release cannot erase a family lease refreshed after it was issued", () => {
  const follower = "agent-global:garden-1:child";
  const releaseCutoff = OLD_EXPIRY;
  const refreshedExpiry = OLD_EXPIRY + 60_000;
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:old", [follower], OLD_EXPIRY - 1),
    reservation("family:refreshed", [follower], refreshedExpiry),
  ], follower, releaseCutoff);

  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:refreshed");
  assert.deepEqual(next[0].agentIds, [follower]);
  assert.equal(next[0].expiresAtMs, refreshedExpiry);
});

test("a same-millisecond lease refresh survives an ambiguous delayed release", () => {
  const follower = "agent-global:garden-1:child";
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:current", [follower], OLD_EXPIRY),
  ], follower, OLD_EXPIRY);

  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:current");
  assert.deepEqual(next[0].agentIds, [follower]);
});

test("refreshing one sibling cannot shield an abandoned sibling from delayed release", () => {
  const abandoned = "agent-global:garden-1:child";
  const partner = "agent-global:garden-1:partner";
  const refreshedExpiry = OLD_EXPIRY + 60_000;
  const refreshed = upsertSettlementFamilyAdmissionReservation(
    [reservation("family:1", [abandoned, partner], OLD_EXPIRY)],
    reservation("family:1", [partner], refreshedExpiry),
  );
  assert.deepEqual(refreshed[0].agentExpiresAtMs, {
    [abandoned]: OLD_EXPIRY,
    [partner]: refreshedExpiry,
  });

  const next = releaseSettlementFamilyAdmissionAgent(refreshed, abandoned, AFTER_OLD_EXPIRY);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].agentIds, [partner]);
  assert.deepEqual(next[0].agentExpiresAtMs, { [partner]: refreshedExpiry });
  assert.equal(next[0].expiresAtMs, refreshedExpiry);
});

test("invalid release cutoffs fail closed instead of dropping capacity promises", () => {
  const follower = "agent-global:garden-1:child";
  const current = [reservation("family:1", [follower])];
  assert.deepEqual(
    releaseSettlementFamilyAdmissionAgent(current, follower, Number.NaN),
    current,
  );
});
