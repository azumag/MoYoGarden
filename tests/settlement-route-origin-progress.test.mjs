import assert from "node:assert/strict";
import test from "node:test";
import { attachAgentOwnership, detachAgentOwnership, globalHandoffAgentId } from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import {
  planAutonomousSettlementMigration,
  prepareSettlementMigrationKit,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function transitPioneer() {
  const state = createInitialWorld({
    seed: 26091420,
    width: 40,
    height: 24,
    regionId: "hex-q1-r1",
  });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  builder.autonomy = true;
  builder.energy = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.settlementMigrationOriginRegionId = "garden-1";
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
    settlementPreviousRegionId: "hex-q1-r0",
  };
  state.agents = [builder];
  state.structures = [];
  state.tick = 43;
  return { state, builder };
}

function foodHalo(state, direction, neighborRegionId, capacity) {
  const sourcePosition = hexGridBoundaryCells(state, direction)[0];
  assert.ok(sourcePosition);
  return {
    direction,
    sourcePosition,
    neighborRegionId,
    neighborPosition: { x: 19, y: 11 },
    tile: {
      x: 19,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 0, maxAmount: capacity },
    },
  };
}

test("transit pioneer only accepts frontier hops that increase distance from its migration origin", () => {
  const { state } = transitPioneer();
  const plan = planAutonomousSettlementMigration(state, [
    // Current region (1,1) is distance 2 from origin (0,0). The much richer
    // SW frontier (0,2) is also distance 2, so following it can circulate around
    // the same ring and eventually close a longer route cycle.
    foodHalo(state, "southWest", "hex-q0-r2", 100),
    // SE (1,2) is distance 3 from the same origin, so it is genuine outward
    // progress even though its sampled carrying capacity is lower.
    foodHalo(state, "southEast", "hex-q1-r2", 12),
  ]);

  assert.ok(plan);
  assert.equal(
    plan.neighborRegionId,
    "hex-q1-r2",
    "support quality must not pull a transit pioneer sideways around the origin ring",
  );
});

test("transit pioneer settles when every improving frontier is non-progressing", () => {
  const { state } = transitPioneer();
  const plan = planAutonomousSettlementMigration(state, [
    foodHalo(state, "southWest", "hex-q0-r2", 100),
  ]);

  assert.equal(
    plan,
    undefined,
    "bounded monotonic progress should fail closed instead of circulating on the same ring",
  );
});

test("camp-kit preparation resets the route origin at settlements and preserves it in transit", () => {
  const settled = createInitialWorld({ seed: 26091421, width: 40, height: 24, regionId: "garden-2" });
  const settledBuilder = settled.agents.find((agent) => agent.role === "builder");
  assert.ok(settledBuilder);
  settledBuilder.capacity = 30;
  settledBuilder.settlementMigrationOriginRegionId = "garden-1";
  settledBuilder.inventory = { wood: 0, stone: 0, food: 0 };
  const settledFaction = settled.factions.find((faction) => faction.id === settledBuilder.factionId);
  assert.ok(settledFaction);
  settledFaction.resources.wood = 100;
  settledFaction.resources.stone = 100;
  settled.structures = [{
    id: "settled-camp",
    factionId: settledBuilder.factionId,
    type: "camp",
    position: { x: 19, y: 11 },
    status: "active",
    progress: BUILD_RECIPES.camp.work,
    requiredProgress: BUILD_RECIPES.camp.work,
    storage: { wood: 0, stone: 0, food: 0 },
  }];
  assert.equal(prepareSettlementMigrationKit(settled, settledBuilder.id), true);
  assert.equal(settledBuilder.settlementMigrationOriginRegionId, "garden-2");

  const transit = createInitialWorld({ seed: 26091422, width: 40, height: 24, regionId: "hex-q2-r0" });
  const transitBuilder = transit.agents.find((agent) => agent.role === "builder");
  assert.ok(transitBuilder);
  transitBuilder.capacity = 30;
  transitBuilder.settlementMigrationOriginRegionId = "garden-1";
  transitBuilder.inventory = { ...BUILD_RECIPES.camp.cost };
  transit.structures = [];
  assert.equal(prepareSettlementMigrationKit(transit, transitBuilder.id), true);
  assert.equal(
    transitBuilder.settlementMigrationOriginRegionId,
    "garden-1",
    "camp-less transit must keep the original route anchor across additional hops",
  );
});

test("ownership handoff preserves the bounded settlement migration origin", () => {
  const source = createInitialWorld({ seed: 26091423, width: 40, height: 24, regionId: "garden-2" });
  const target = createInitialWorld({ seed: 26091424, width: 40, height: 24, regionId: "garden-3" });
  const builder = source.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  builder.autonomy = true;
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  builder.settlementMigrationOriginRegionId = "garden-1";
  builder.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "move",
    target: { x: 19, y: 11 },
  };
  target.structures = [];
  const targetTile = target.tiles[11 * target.width + 19];
  assert.ok(targetTile);
  targetTile.terrain = "plain";

  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    { x: 19, y: 11 },
    source.regionId,
  );
  assert.equal(attached.ok, true);
  const arrived = attached.value.state.agents.find(
    (agent) => agent.id === globalHandoffAgentId(builder.id, source.regionId),
  );
  assert.ok(arrived);
  assert.equal(arrived.settlementMigrationOriginRegionId, "garden-1");
  assert.equal(arrived.task?.type, "build");
  assert.equal(arrived.task?.settlementPreviousRegionId, "garden-2");
});
