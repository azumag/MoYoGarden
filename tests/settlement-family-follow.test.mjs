import assert from "node:assert/strict";
import test from "node:test";
import { attachAgentOwnership, globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  hasSettlementFamilyFollow,
  planSettlementFamilyFollow,
  registerSettlementFamilyFollowers,
  settlementFamilyAdmissionHeadroom,
  settlementFamilyAdmissionReady,
  settlementFamilyHousingHeadroom,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function clearHex(state) {
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
}

function baseAgent(state) {
  const agent = state.agents[0];
  assert.ok(agent);
  return structuredClone(agent);
}

test("settled pioneer registers a bounded partner-caregiver-dependent family group", () => {
  const state = createInitialWorld({ seed: 260916, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const template = baseAgent(state);
  const pioneerLocalId = "pioneer";
  const pioneerId = globalHandoffAgentId(pioneerLocalId, state.regionId);
  const partner = { ...structuredClone(template), id: "partner", factionId: template.factionId, hp: 100 };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
    position: { x: 20, y: 11 },
  };
  partner.position = { x: 20, y: 11 };
  const unrelated = { ...structuredClone(template), id: "unrelated", factionId: template.factionId, hp: 100 };
  state.agents = [partner, child, unrelated];

  const result = registerSettlementFamilyFollowers(
    state,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, state.regionId),
  );

  assert.deepEqual(new Set(result.agentIds), new Set(["partner", "child"]));
  assert.equal(partner.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(child.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(unrelated.settlementFamilyTargetRegionId, undefined);
});

test("family admission requires a camp, storage headroom, and usable food support", () => {
  const state = createInitialWorld({ seed: 260917, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(state);
  const faction = state.factions[0];
  assert.ok(faction);
  state.structures = [{
    id: "frontier-camp",
    factionId: faction.id,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];
  faction.resources = { wood: 0, stone: 0, food: 0 };
  assert.equal(settlementFamilyAdmissionReady(state, faction.id), false);
  state.structures[0].storage.food = 2;
  assert.equal(
    settlementFamilyAdmissionReady(state, faction.id),
    true,
    "food already stored in an active faction structure should support family admission",
  );
  state.structures[0].storage.food = 0;
  const foodTile = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");
  assert.ok(foodTile);
  foodTile.resource = { kind: "food", amount: 3, maxAmount: 3 };
  assert.equal(settlementFamilyAdmissionReady(state, faction.id), true);
});

test("family admission headroom is bounded by physical food support", () => {
  const state = createInitialWorld({ seed: 260924, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(state);
  const faction = state.factions[0];
  assert.ok(faction);
  const residentTemplate = baseAgent(state);
  state.structures = [{
    id: "frontier-camp",
    factionId: faction.id,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 1 },
  }];
  faction.resources = { wood: 0, stone: 0, food: 1 };
  state.agents = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(residentTemplate),
    id: `resident-${index}`,
    factionId: faction.id,
    hp: 100,
  }));

  assert.equal(settlementFamilyHousingHeadroom(state, faction.id), 2);
  assert.equal(
    settlementFamilyAdmissionHeadroom(state, faction.id),
    1,
    "one physical food unit must not authorize two family followers",
  );

  const foodTile = state.tiles.find((tile) => isHexGridCell(state, tile) && tile.terrain !== "water");
  assert.ok(foodTile);
  foodTile.resource = { kind: "food", amount: 3, maxAmount: 3 };
  assert.equal(
    settlementFamilyAdmissionHeadroom(state, faction.id),
    2,
    "additional live food may fill the remaining housing headroom",
  );
});

test("family follow chooses a neighboring region that strictly approaches the final target", () => {
  const state = createInitialWorld({ seed: 260918, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const follower = baseAgent(state);
  follower.id = "follower";
  follower.position = { x: 19, y: 11 };
  follower.energy = 100;
  follower.settlementFamilyTargetRegionId = "hex-q2-r0";
  delete follower.task;
  state.agents = [follower];
  const seam = { x: 30, y: 11 };
  const plan = planSettlementFamilyFollow(state, [
    {
      direction: "E",
      sourcePosition: seam,
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    },
    {
      direction: "NE",
      sourcePosition: seam,
      neighborRegionId: "hex-q1-r-1",
      neighborPosition: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    },
  ]);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.targetRegionId, "hex-q2-r0");
  assert.equal(hasSettlementFamilyFollow(state), true);
});

test("external family task remains authoritative", () => {
  const state = createInitialWorld({ seed: 260919, width: 40, height: 24, regionId: "garden-1" });
  clearHex(state);
  const follower = baseAgent(state);
  follower.id = "follower";
  follower.position = { x: 19, y: 11 };
  follower.energy = 100;
  follower.settlementFamilyTargetRegionId = "hex-q1-r0";
  follower.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "move",
    target: { x: 20, y: 11 },
  };
  state.agents = [follower];
  assert.equal(planSettlementFamilyFollow(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
  }]), undefined);
});

test("ownership attach clears the family target only on final arrival", () => {
  const source = createInitialWorld({ seed: 260920, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 260921, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(target);
  const moving = baseAgent(source);
  moving.id = "family-follower";
  moving.factionId = target.factions[0].id;
  moving.settlementFamilyTargetRegionId = target.regionId;
  delete moving.task;
  target.agents = target.agents.filter((agent) => agent.id !== globalHandoffAgentId(moving.id, source.regionId));
  const result = attachAgentOwnership(target, [], moving, { x: 19, y: 11 }, source.regionId);
  assert.equal(result.ok, true, result.reason);
  const arrived = result.value?.state.agents.find((agent) => agent.id === globalHandoffAgentId(moving.id, source.regionId));
  assert.ok(arrived);
  assert.equal(arrived.settlementFamilyTargetRegionId, undefined);
});


test("family admission uses camp resident headroom and follower registration respects it", () => {
  const destination = createInitialWorld({ seed: 260922, width: 40, height: 24, regionId: "hex-q1-r0" });
  clearHex(destination);
  const faction = destination.factions[0];
  assert.ok(faction);
  const residentTemplate = baseAgent(destination);
  destination.structures = [{
    id: "frontier-camp",
    factionId: faction.id,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];
  faction.resources = { wood: 0, stone: 0, food: 2 };
  destination.agents = Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(residentTemplate),
    id: `resident-${index}`,
    factionId: faction.id,
    hp: 100,
  }));
  assert.equal(settlementFamilyHousingHeadroom(destination, faction.id), 1);
  assert.equal(settlementFamilyAdmissionReady(destination, faction.id), true);
  destination.agents.push({
    ...structuredClone(residentTemplate),
    id: "resident-full",
    factionId: faction.id,
    hp: 100,
  });
  assert.equal(settlementFamilyHousingHeadroom(destination, faction.id), 0);
  assert.equal(settlementFamilyAdmissionReady(destination, faction.id), false);

  const source = createInitialWorld({ seed: 260923, width: 40, height: 24, regionId: "garden-1" });
  clearHex(source);
  const template = baseAgent(source);
  const pioneerId = globalHandoffAgentId("pioneer", source.regionId);
  const partner = { ...structuredClone(template), id: "partner", factionId: template.factionId, hp: 100 };
  const child = {
    ...structuredClone(template),
    id: "child",
    factionId: template.factionId,
    hp: 100,
    autonomy: false,
    lifeStage: "infant",
    parents: [pioneerId, partner.id],
  };
  source.agents = [partner, child];
  const limited = registerSettlementFamilyFollowers(
    source,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, source.regionId),
    1,
  );
  assert.deepEqual(
    limited.agentIds,
    [],
    "one admission slot must not split an infant from its active caregiver",
  );
  assert.equal(partner.settlementFamilyTargetRegionId, undefined);
  assert.equal(child.settlementFamilyTargetRegionId, undefined);

  const admittedTogether = registerSettlementFamilyFollowers(
    source,
    pioneerId,
    "hex-q1-r0",
    template.factionId,
    globalHandoffAgentId(partner.id, source.regionId),
    2,
  );
  assert.deepEqual(admittedTogether.agentIds, ["partner", "child"]);
  assert.equal(partner.settlementFamilyTargetRegionId, "hex-q1-r0");
  assert.equal(child.settlementFamilyTargetRegionId, "hex-q1-r0");
});
