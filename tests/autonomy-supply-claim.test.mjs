import assert from "node:assert/strict";
import test from "node:test";
import { planAutonomousHaloTravel } from "../dist-ts/src/autonomy-region.js";
import {
  hexGridBoundaryCells,
  hexGridCenter,
  hexGridHandoffTarget,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function depletedInteriorWoodcutter() {
  const state = createInitialWorld({
    seed: 676767,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const agent = state.agents[0];
  assert.ok(agent);
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
    if (isHexGridCell(state, tile)) tile.terrain = "plain";
  }
  for (const candidate of state.agents) candidate.autonomy = candidate.id === agent.id;
  state.tick = 24;
  agent.position = hexGridCenter(state);
  agent.role = "woodcutter";
  agent.capacity = 12;
  agent.inventory = { wood: 0, stone: 0, food: 0 };
  agent.energy = 100;
  agent.task = {
    source: "autonomy",
    issuedAtTick: 20,
    type: "gather",
    resource: "wood",
  };
  return { state, agent };
}

function haloResource(state, direction, regionId, amount) {
  const cells = hexGridBoundaryCells(state, direction);
  const sourcePosition = cells[Math.floor(cells.length / 2)];
  assert.ok(sourcePosition);
  const sourceTile = state.tiles[sourcePosition.y * state.width + sourcePosition.x];
  assert.ok(sourceTile);
  sourceTile.terrain = "plain";
  const neighborPosition = hexGridHandoffTarget(state, sourcePosition, direction);
  assert.ok(neighborPosition);
  return {
    sourceRegionId: state.regionId,
    sourcePosition: { ...sourcePosition },
    direction,
    neighborRegionId: regionId,
    neighborPosition: { ...neighborPosition },
    tile: {
      x: neighborPosition.x,
      y: neighborPosition.y,
      terrain: "forest",
      resource: { kind: "wood", amount, maxAmount: amount },
    },
  };
}

test("autonomy does not re-dispatch into neighbor supply claimed by an earlier expedition", () => {
  const { state } = depletedInteriorWoodcutter();
  const east = haloResource(state, "east", "garden-2", 4);
  const west = haloResource(state, "west", "garden-4", 12);

  const withoutClaim = planAutonomousHaloTravel(state, [east, west]);
  assert.ok(withoutClaim);
  assert.equal(withoutClaim.direction, "west");

  const expiredClaim = planAutonomousHaloTravel(state, [east, west], [{
    claimId: "expired-expedition",
    resource: "wood",
    direction: "west",
    neighborRegionId: "garden-4",
    amount: 10,
    expiresAtTick: state.tick,
  }]);
  assert.ok(expiredClaim);
  assert.equal(expiredClaim.direction, "west");

  const withClaim = planAutonomousHaloTravel(state, [east, west], [{
    claimId: "prior-expedition",
    resource: "wood",
    direction: "west",
    neighborRegionId: "garden-4",
    amount: 10,
    expiresAtTick: state.tick + 60,
  }]);
  assert.ok(withClaim);
  assert.equal(
    withClaim.direction,
    "east",
    "a later scout must score only the unclaimed share of neighbor supply",
  );
});
