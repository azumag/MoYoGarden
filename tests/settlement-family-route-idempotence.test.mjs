import assert from "node:assert/strict";
import test from "node:test";
import { globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { registerSettlementFamilyFollowers } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function templateAgent(state) {
  const agent = state.agents[0];
  assert.ok(agent);
  return structuredClone(agent);
}

test("family registration preserves an existing different settlement route", () => {
  const state = createInitialWorld({ seed: 26092011, width: 40, height: 24, regionId: "garden-1" });
  const template = templateAgent(state);
  const pioneerId = globalHandoffAgentId("pioneer", state.regionId);
  const previousTarget = "hex-q0-r1";
  const requestedTarget = "hex-q1-r0";
  const partner = {
    ...structuredClone(template),
    id: "partner",
    factionId: template.factionId,
    hp: 100,
    settlementFamilyTargetRegionId: previousTarget,
  };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
    settlementFamilyTargetRegionId: previousTarget,
  };
  state.agents = [partner, child];

  const conflict = registerSettlementFamilyFollowers(
    state,
    pioneerId,
    requestedTarget,
    template.factionId,
    globalHandoffAgentId(partner.id, state.regionId),
    2,
  );
  assert.deepEqual(conflict.agentIds, []);
  assert.equal(conflict.candidateCount, 0);
  assert.equal(partner.settlementFamilyTargetRegionId, previousTarget);
  assert.equal(child.settlementFamilyTargetRegionId, previousTarget);

  partner.settlementFamilyTargetRegionId = requestedTarget;
  child.settlementFamilyTargetRegionId = requestedTarget;
  const retry = registerSettlementFamilyFollowers(
    state,
    pioneerId,
    requestedTarget,
    template.factionId,
    globalHandoffAgentId(partner.id, state.regionId),
    2,
  );
  assert.deepEqual(retry.agentIds, ["partner", "child"]);
  assert.equal(retry.candidateCount, 2);
  assert.equal(partner.settlementFamilyTargetRegionId, requestedTarget);
  assert.equal(child.settlementFamilyTargetRegionId, requestedTarget);
});
