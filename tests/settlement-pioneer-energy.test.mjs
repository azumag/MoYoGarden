import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("equivalent settlement routes prefer the higher-energy pioneer", () => {
  const state = createInitialWorld({ seed: 260914, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);
  const low = structuredClone(template);
  const high = structuredClone(template);
  low.id = "agent-a-low-energy-pioneer";
  high.id = "agent-z-high-energy-pioneer";
  low.autonomy = true;
  high.autonomy = true;
  low.energy = 40;
  high.energy = 90;
  low.position = { x: 19, y: 11 };
  high.position = { x: 19, y: 11 };
  const kit = {
    wood: BUILD_RECIPES.camp.cost.wood,
    stone: BUILD_RECIPES.camp.cost.stone,
    food: BUILD_RECIPES.camp.cost.food,
  };
  low.inventory = { ...kit };
  high.inventory = { ...kit };
  low.task = { source: "autonomy", issuedAtTick: state.tick, type: "build", structureType: "camp" };
  high.task = structuredClone(low.task);
  state.agents = [low, high];
  state.structures = [];
  state.tick = 25;

  const plan = planAutonomousSettlementMigration(state, [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 8, maxAmount: 20 },
    },
  }]);
  assert.ok(plan);
  assert.equal(plan.agentId, high.id);
});
