import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 260916, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.agents = [builder];
  state.structures = [];
  state.tick = 25;
  builder.autonomy = true;
  builder.energy = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { wood: 8, stone: 4, food: 0 };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }
  return { state, builder };
}

function candidate(direction, sourcePosition, regionId, neighborPosition, summary) {
  return {
    direction,
    sourcePosition,
    neighborRegionId: regionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
    },
    neighborRegionSummary: summary,
  };
}

function summary(occupants, occupantsByFaction) {
  return {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 0, storehouse: 0, market: 0, workshop: 0 },
    passableCells: 100,
    occupants,
    ...(occupantsByFaction === undefined ? {} : { occupantsByFaction }),
  };
}

test("migration prefers a same-faction foothold when total pressure and ecology tie", () => {
  const { state, builder } = fixture();
  const seam = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(state, [
    candidate(
      "E",
      seam,
      "hex-q1-r0",
      { x: 8, y: 11 },
      summary(2, { [builder.factionId]: 1, rival: 1 }),
    ),
    candidate(
      "W",
      seam,
      "hex-q-1-r0",
      { x: 30, y: 11 },
      summary(2, { rival: 2 }),
    ),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "E");
});

test("truncated faction composition stays neutral when the pioneer faction is omitted", () => {
  const { state, builder } = fixture();
  const seam = { x: 30, y: 11 };
  const baseline = planAutonomousSettlementMigration(state, [
    candidate(
      "E",
      seam,
      "hex-q1-r0",
      { x: 8, y: 11 },
      summary(2),
    ),
    candidate(
      "W",
      seam,
      "hex-q-1-r0",
      { x: 30, y: 11 },
      summary(2),
    ),
  ]);
  assert.ok(baseline);
  const plan = planAutonomousSettlementMigration(state, [
    candidate(
      "E",
      seam,
      "hex-q1-r0",
      { x: 8, y: 11 },
      summary(2, { rival: 1 }),
    ),
    candidate(
      "W",
      seam,
      "hex-q-1-r0",
      { x: 30, y: 11 },
      summary(2, { rival: 2 }),
    ),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    baseline.neighborRegionId,
    "an omitted faction in an incomplete top-N summary must remain neutral",
  );
});
