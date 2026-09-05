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

function haloResource(state, direction, index, regionId, kind = "wood", amount = 6) {
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
      resource: { kind, amount, maxAmount: Math.max(8, amount) },
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

test("interior autonomy weighs visible supply against travel cost and carrying capacity", () => {
  const { state, agent } = depletedInteriorWoodcutter();
  const eastCells = hexGridBoundaryCells(state, "east");
  const westCells = hexGridBoundaryCells(state, "west");
  const east = haloResource(
    state,
    "east",
    Math.floor(eastCells.length / 2),
    "garden-2",
    "wood",
    2,
  );
  const westA = haloResource(
    state,
    "west",
    Math.floor(westCells.length / 2),
    "garden-4",
    "wood",
    6,
  );
  const westB = haloResource(
    state,
    "west",
    Math.min(westCells.length - 1, Math.floor(westCells.length / 2) + 1),
    "garden-4",
    "wood",
    6,
  );

  const richerPlan = planAutonomousHaloTravel(state, [east, westA, westB]);
  assert.ok(richerPlan);
  assert.equal(richerPlan.direction, "west");
  assert.equal(richerPlan.neighborRegionId, "garden-4");

  agent.inventory.wood = agent.capacity - 2;
  const capacityLimitedPlan = planAutonomousHaloTravel(state, [east, westA, westB]);
  assert.ok(capacityLimitedPlan);
  assert.equal(capacityLimitedPlan.direction, "east");
});

test("interior autonomy preserves its low-energy reserve when planning region travel", () => {
  const { state, agent } = depletedInteriorWoodcutter();
  const eastCells = hexGridBoundaryCells(state, "east");
  const east = haloResource(state, "east", Math.floor(eastCells.length / 2), "garden-2");

  agent.energy = 28;
  assert.equal(planAutonomousHaloTravel(state, [east]), undefined);

  agent.energy = 29;
  const affordable = planAutonomousHaloTravel(state, [east]);
  assert.ok(affordable);
  assert.equal(affordable.direction, "east");
});

test("interior autonomy gives the single travel slot to the most efficient eligible agent", () => {
  const { state } = depletedInteriorWoodcutter();
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  const firstById = agents[0];
  const secondById = agents[1];
  assert.ok(firstById);
  assert.ok(secondById);

  for (const agent of state.agents) agent.autonomy = false;
  const center = hexGridCenter(state);
  for (const [index, agent] of [firstById, secondById].entries()) {
    agent.autonomy = true;
    agent.position = { ...center };
    agent.role = "woodcutter";
    agent.energy = 100;
    agent.inventory = { wood: 0, stone: 0, food: 0 };
    agent.task = {
      source: "autonomy",
      issuedAtTick: 20 + index,
      type: "gather",
      resource: "wood",
    };
  }

  firstById.inventory.wood = firstById.capacity - 1;
  const eastCells = hexGridBoundaryCells(state, "east");
  const east = haloResource(
    state,
    "east",
    Math.floor(eastCells.length / 2),
    "garden-2",
    "wood",
    8,
  );

  const efficientPlan = planAutonomousHaloTravel(state, [east]);
  assert.ok(efficientPlan);
  assert.equal(
    efficientPlan.agentId,
    secondById.id,
    "the planner should not reserve the only travel slot for a lower-capacity agent just because its id sorts first",
  );

  secondById.inventory.wood = secondById.capacity - 1;
  const tiedPlan = planAutonomousHaloTravel(state, [east]);
  assert.ok(tiedPlan);
  assert.equal(
    tiedPlan.agentId,
    firstById.id,
    "equal expedition costs should retain a deterministic agent-id tie break",
  );
});
