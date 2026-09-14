import assert from "node:assert/strict";
import test from "node:test";
import { planAutonomousHaloTravel } from "../dist-ts/src/autonomy-region.js";
import {
  hexGridBoundaryCells,
  hexGridCenter,
  hexGridHandoffTarget,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { materializeHexHalo } from "../dist-ts/src/hex-halo.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("hex halo carries a bounded neighbor-cell occupancy signal", () => {
  const link = {
    sourceRegionId: "garden-1",
    sourcePosition: { x: 30, y: 11 },
    direction: "east",
    neighborRegionId: "garden-2",
    neighborPosition: { x: 8, y: 11 },
    neighborDirection: "west",
  };
  const halo = materializeHexHalo([link], [{
    regionId: "garden-2",
    direction: "west",
    revision: 4,
    tick: 12,
    tiles: [{
      position: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
      occupants: 3,
    }],
  }]);
  assert.equal(halo.length, 1);
  assert.equal(halo[0].neighborOccupants, 3);

  const legacy = materializeHexHalo([link], [{
    regionId: "garden-2",
    direction: "west",
    revision: 3,
    tick: 11,
    tiles: [{
      position: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    }],
  }]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].neighborOccupants, undefined);
});

test("cross-region resource travel avoids an equally supplied crowded arrival cell", () => {
  const state = createInitialWorld({
    seed: 260915,
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
  state.agents = [agent];
  state.tick = 24;
  agent.autonomy = true;
  agent.role = "woodcutter";
  agent.energy = 100;
  agent.position = hexGridCenter(state);
  agent.inventory = { wood: 0, stone: 0, food: 0 };
  agent.task = {
    source: "autonomy",
    issuedAtTick: 20,
    type: "gather",
    resource: "wood",
  };

  const makeHalo = (direction, regionId, occupants) => {
    const cells = hexGridBoundaryCells(state, direction);
    const sourcePosition = cells[Math.floor(cells.length / 2)];
    assert.ok(sourcePosition);
    const neighborPosition = hexGridHandoffTarget(state, sourcePosition, direction);
    assert.ok(neighborPosition);
    return {
      sourceRegionId: state.regionId,
      sourcePosition: { ...sourcePosition },
      direction,
      neighborRegionId: regionId,
      neighborPosition: { ...neighborPosition },
      neighborOccupants: occupants,
      tile: {
        x: neighborPosition.x,
        y: neighborPosition.y,
        terrain: "forest",
        elevation: 0.5,
        resource: { kind: "wood", amount: 8, maxAmount: 8 },
      },
    };
  };

  const east = makeHalo("east", "garden-2", 4);
  const west = makeHalo("west", "hex-q-1-r0", 0);
  const plan = planAutonomousHaloTravel(state, [east, west]);
  assert.ok(plan);
  assert.equal(plan.direction, "west");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});
