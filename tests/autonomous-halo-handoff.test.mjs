import assert from "node:assert/strict";
import test from "node:test";
import { planAutonomousHaloHandoff } from "../dist-ts/src/autonomy-region.js";
import {
  hexGridBoundaryCells,
  hexGridHandoffTarget,
} from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function stateWithBoundaryWoodIntent() {
  const state = createInitialWorld({
    seed: 424242,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const agent = state.agents[0];
  assert.ok(agent);
  const sourcePosition = hexGridBoundaryCells(state, "east")[5];
  assert.ok(sourcePosition);
  const neighborPosition = hexGridHandoffTarget(state, sourcePosition, "east");
  assert.ok(neighborPosition);

  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
  }
  const sourceTile = state.tiles[sourcePosition.y * state.width + sourcePosition.x];
  assert.ok(sourceTile);
  sourceTile.terrain = "plain";
  agent.position = { ...sourcePosition };
  agent.role = "woodcutter";
  agent.autonomy = true;
  agent.task = {
    source: "autonomy",
    issuedAtTick: 17,
    type: "gather",
    resource: "wood",
  };

  const halo = [{
    sourceRegionId: "garden-1",
    sourcePosition: { ...sourcePosition },
    direction: "east",
    neighborRegionId: "garden-2",
    neighborPosition: { ...neighborPosition },
    tile: {
      x: neighborPosition.x,
      y: neighborPosition.y,
      terrain: "forest",
      resource: { kind: "wood", amount: 8, maxAmount: 8 },
    },
  }];
  return { state, agent, halo };
}

test("autonomy selects a visible neighboring resource only after local supply is exhausted", () => {
  const { state, agent, halo } = stateWithBoundaryWoodIntent();
  const plan = planAutonomousHaloHandoff(state, halo);
  assert.ok(plan);
  assert.equal(plan.agentId, agent.id);
  assert.equal(plan.direction, "east");
  assert.equal(plan.resource, "wood");
  assert.equal(plan.neighborRegionId, "garden-2");
  assert.equal(plan.transferId, `autonomy:garden-1:${agent.id}:17:east`);

  const localTile = state.tiles.find((tile) => tile.terrain !== "water");
  assert.ok(localTile);
  localTile.resource = { kind: "wood", amount: 1, maxAmount: 1 };
  assert.equal(planAutonomousHaloHandoff(state, halo), undefined);
});

test("idle resource specialists can cross after depletion without inventing a distant target", () => {
  const { state, agent, halo } = stateWithBoundaryWoodIntent();
  delete agent.task;
  state.tick = 31;
  const plan = planAutonomousHaloHandoff(state, halo);
  assert.ok(plan);
  assert.equal(plan.resource, "wood");
  assert.equal(plan.transferId, `autonomy:garden-1:${agent.id}:31:east`);

  halo[0].tile.resource = { kind: "food", amount: 8, maxAmount: 8 };
  assert.equal(planAutonomousHaloHandoff(state, halo), undefined);
});