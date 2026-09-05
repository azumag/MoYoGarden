import assert from "node:assert/strict";
import test from "node:test";
import {
  planAutonomousHaloTravel,
  shouldScoutAutonomyHalo,
} from "../dist-ts/src/autonomy-region.js";
import {
  hexGridBoundaryCells,
  hexGridCenter,
  hexGridHandoffTarget,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function depletedInteriorWoodcutter() {
  const state = createInitialWorld({
    seed: 565656,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const agent = state.agents[0];
  assert.ok(agent);
  for (const tile of state.tiles) {
    if (tile.resource?.kind === "wood") tile.resource.amount = 0;
  }
  for (const candidate of state.agents) candidate.autonomy = candidate.id === agent.id;
  state.tick = 24;
  agent.position = hexGridCenter(state);
  agent.role = "woodcutter";
  agent.task = {
    source: "autonomy",
    issuedAtTick: 19,
    type: "gather",
    resource: "wood",
  };
  return { state, agent };
}

function haloResource(state, direction, index, regionId, kind = "wood") {
  const cells = hexGridBoundaryCells(state, direction);
  const sourcePosition = cells[index];
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
      resource: { kind, amount: 6, maxAmount: 8 },
    },
  };
}

test("interior autonomy scouts depleted supply on a bounded cadence", () => {
  const { state } = depletedInteriorWoodcutter();
  assert.equal(isHexGridCell(state, state.agents[0].position), true);
  assert.equal(shouldScoutAutonomyHalo(state), true);
  state.tick += 1;
  assert.equal(shouldScoutAutonomyHalo(state), false);

  state.tick = 36;
  const localTile = state.tiles.find((tile) => tile.terrain !== "water");
  assert.ok(localTile);
  localTile.resource = { kind: "wood", amount: 1, maxAmount: 1 };
  assert.equal(shouldScoutAutonomyHalo(state), false);
});

test("interior autonomy chooses a reachable seam with matching neighbor supply", () => {
  const { state, agent } = depletedInteriorWoodcutter();
  const eastCells = hexGridBoundaryCells(state, "east");
  const westCells = hexGridBoundaryCells(state, "west");
  const east = haloResource(state, "east", Math.floor(eastCells.length / 2), "garden-2");
  const west = haloResource(state, "west", Math.floor(westCells.length / 2), "garden-4");
  const wrongKind = haloResource(state, "northEast", 0, "garden-3", "food");

  const plan = planAutonomousHaloTravel(state, [west, wrongKind, east]);
  assert.ok(plan);
  assert.equal(plan.agentId, agent.id);
  assert.equal(plan.resource, "wood");
  assert.equal(plan.issuedAtTick, 19);
  assert.equal(plan.startedAtTick, 24);
  assert.equal(plan.direction, "east");
  assert.equal(plan.neighborRegionId, "garden-2");
  assert.deepEqual(plan.boundaryTarget, east.sourcePosition);

  const sourceTile = state.tiles[east.sourcePosition.y * state.width + east.sourcePosition.x];
  assert.ok(sourceTile);
  sourceTile.terrain = "water";
  const fallback = planAutonomousHaloTravel(state, [east, west]);
  assert.ok(fallback);
  assert.equal(fallback.direction, "west");
  assert.deepEqual(fallback.boundaryTarget, west.sourcePosition);
});
