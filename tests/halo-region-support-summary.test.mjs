import assert from "node:assert/strict";
import test from "node:test";
import {
  planAutonomousHaloHandoff,
  planAutonomousHaloTravel,
} from "../dist-ts/src/autonomy-region.js";
import {
  hexGridBoundaryCells,
  hexGridCenter,
  hexGridHandoffTarget,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { materializeHexHalo } from "../dist-ts/src/hex-halo.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function woodcutterFixture() {
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
  return { state, agent };
}

function interiorSupplyHalo(state, direction = "east") {
  const cells = hexGridBoundaryCells(state, direction);
  const sourcePosition = cells[Math.floor(cells.length / 2)];
  assert.ok(sourcePosition);
  const neighborPosition = hexGridHandoffTarget(state, sourcePosition, direction);
  assert.ok(neighborPosition);
  return {
    sourceRegionId: state.regionId,
    sourcePosition: { ...sourcePosition },
    direction,
    neighborRegionId: "garden-2",
    neighborPosition: { ...neighborPosition },
    neighborDirection: "west",
    tile: {
      x: neighborPosition.x,
      y: neighborPosition.y,
      terrain: "plain",
      elevation: 0.5,
    },
    neighborRegionSummary: {
      resources: { wood: 12, stone: 0, food: 0 },
      passableCells: 397,
      occupants: 2,
    },
  };
}

test("materialized halo carries a bounded whole-region support summary with legacy fallback", () => {
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
    regionSummary: {
      resources: { wood: 12, stone: 3, food: 5 },
      resourceCapacity: { wood: 30, stone: 9, food: 14 },
      passableCells: 390,
      occupants: 9,
    },
    tiles: [{
      position: { x: 8, y: 11 },
      tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 },
    }],
  }]);
  assert.deepEqual(halo[0].neighborRegionSummary, {
    resources: { wood: 12, stone: 3, food: 5 },
    resourceCapacity: { wood: 30, stone: 9, food: 14 },
    passableCells: 390,
    occupants: 9,
  });

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
  assert.equal(legacy[0].neighborRegionSummary, undefined);
});

test("resource expedition can target interior neighbor supply through a passable empty seam", () => {
  const { state } = woodcutterFixture();
  const halo = interiorSupplyHalo(state);
  const plan = planAutonomousHaloTravel(state, [halo]);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "garden-2");
  assert.equal(plan.direction, "east");
  assert.ok((plan.claimedSupply ?? 0) > 0);
});

test("reserved interior supply authorizes the matching empty-boundary handoff", () => {
  const { state, agent } = woodcutterFixture();
  const halo = interiorSupplyHalo(state);
  agent.position = { ...halo.sourcePosition };
  const claim = {
    claimId: "region-summary-wood",
    agentId: agent.id,
    resource: "wood",
    direction: "east",
    neighborRegionId: "garden-2",
    amount: 6,
    expiresAtTick: state.tick + 12,
  };
  const plan = planAutonomousHaloHandoff(state, [halo], [claim]);
  assert.ok(plan);
  assert.equal(plan.claimId, claim.claimId);
  assert.equal(plan.neighborRegionId, "garden-2");
});
