import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitFixture({ amount = 4, drainage = 0.2 } = {}) {
  const state = createInitialWorld({ seed: 260914, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    tile.drainage = drainage;
    tile.pathogenReservoir = 0.2;
    tile.resource = { kind: "food", amount, maxAmount: 12 };
  }

  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.agents = [builder];
  state.structures = [];
  state.tick = 31;
  builder.autonomy = true;
  builder.energy = 100;
  builder.capacity = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  return state;
}

function frontier({ amount, drainage = 0.2, withWater = false }) {
  const halo = [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      drainage,
      pathogenReservoir: 0.2,
      resource: { kind: "food", amount, maxAmount: 12 },
    },
  }];
  if (withWater) {
    halo.push({
      direction: "E",
      sourcePosition: { x: 30, y: 11 },
      neighborRegionId: "hex-q1-r0",
      neighborPosition: { x: 8, y: 12 },
      tile: {
        x: 8,
        y: 12,
        terrain: "water",
        elevation: 0.3,
        drainage: 0,
      },
    });
  }
  return halo;
}

test("transit pioneer continues toward higher live food density when durable support ties", () => {
  const state = transitFixture({ amount: 4 });
  const plan = planAutonomousSettlementMigration(state, frontier({ amount: 8 }));

  assert.ok(plan);
  assert.equal(plan.direction, "E");
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
});

test("water and drainage cannot override lower live food density when capacity and pathogen tie", () => {
  const state = transitFixture({ amount: 4, drainage: 0.2 });
  const plan = planAutonomousSettlementMigration(
    state,
    frontier({ amount: 2, drainage: 1, withWater: true }),
  );

  assert.equal(plan, undefined);
});
