import assert from "node:assert/strict";
import test from "node:test";
import { releaseSettlementFamilyAdmissionAgent } from "../dist-ts/src/settlement-family-reservation.js";

function reservation(id, agentIds) {
  return {
    reservationId: id,
    sourceRegionId: "garden-1",
    pioneerId: "agent-global:garden-1:pioneer",
    factionId: "faction-1",
    agentIds,
    expiresAtMs: 2_000_000_000_000,
  };
}

test("family admission release removes only the abandoned follower slot", () => {
  const abandoned = "agent-global:garden-1:child";
  const partner = "agent-global:garden-1:partner";
  const next = releaseSettlementFamilyAdmissionAgent([reservation("family:1", [abandoned, partner])], abandoned);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].agentIds, [partner]);
});

test("family admission release drops an empty reservation and is idempotent", () => {
  const abandoned = "agent-global:garden-1:child";
  const first = releaseSettlementFamilyAdmissionAgent([reservation("family:1", [abandoned])], abandoned);
  assert.deepEqual(first, []);
  assert.deepEqual(releaseSettlementFamilyAdmissionAgent(first, abandoned), []);
});

test("family admission release clears duplicate stale promises without touching other followers", () => {
  const abandoned = "agent-global:garden-1:child";
  const other = "agent-global:garden-1:other";
  const next = releaseSettlementFamilyAdmissionAgent([
    reservation("family:1", [abandoned, other]),
    reservation("family:2", [abandoned]),
  ], abandoned);
  assert.equal(next.length, 1);
  assert.equal(next[0].reservationId, "family:1");
  assert.deepEqual(next[0].agentIds, [other]);
});
