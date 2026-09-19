import assert from "node:assert/strict";
import test from "node:test";
import { releaseSettlementFamilyAdmissionAgent } from "../dist-ts/src/settlement-family-reservation.js";

const OLD_EXPIRY = 2_000_000_000_000;

function reservation(id, agentIds, expiresAtMs = OLD_EXPIRY) {
  return {
    reservationId: id,
    sourceRegionId: "garden-1",
    pioneerId: "agent-global:garden-1:pioneer",
    factionId: "faction-1",
    agentIds,
    expiresAtMs,
  };
}

test("family admission release removes only the abandoned follower slot", () => {
  const abandoned = "agent-global:garden-1:child";
  const partner = "agent-global:garden-1:partner";
  const next = releaseSettlementFamilyAdmissionAgent(
    [reservation("family:1", [abandoned, partner])],
    abandoned,
    OLD_EXPIRY,
  );
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].agentIds, [partner]);
});

test("family admission release drops an empty reservation and is idempotent", () => {
  const abandoned = "agent-global:garden-1:child";
  const first = releaseSettlementFamilyAdmissionAgent(
    [reservation("family:1", [abandoned])],
    abandoned,
    OLD_EXPIRY,
  );
  assert.deepEqual(first, []);
  assert.deepEqual(
    releaseSettlementFamilyAdmissionAgent(first, abandoned, OLD_EXPIRY),
    [],
  );
});

test("family admission release clears duplicate stale promises without touching other followers", () => {
  const abandoned = "agent-global:garden-1:child";
  const other = "agent-global:garden-1:other";
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:1", [abandoned, other]),
    reservation("family:2", [abandoned]),
  ], abandoned, OLD_EXPIRY);
  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:1");
  assert.deepEqual(next[0].agentIds, [other]);
});

test("a delayed release cannot erase a family lease refreshed after it was issued", () => {
  const follower = "agent-global:garden-1:child";
  const releaseCutoff = OLD_EXPIRY;
  const refreshedExpiry = OLD_EXPIRY + 60_000;
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:old", [follower], OLD_EXPIRY),
    reservation("family:refreshed", [follower], refreshedExpiry),
  ], follower, releaseCutoff);

  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:refreshed");
  assert.deepEqual(next[0].agentIds, [follower]);
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
