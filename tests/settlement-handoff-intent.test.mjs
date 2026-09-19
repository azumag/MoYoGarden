import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { hexGridBoundaryCells, hexGridHandoffTarget } from "../dist-ts/src/hex-grid.js";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function crossingBuilder(marker) {
  const source = createInitialWorld({ seed: 26092001, width: 40, height: 24, regionId: "garden-1" });
  const target = createInitialWorld({ seed: 26092002, width: 40, height: 24, regionId: "garden-2" });
  const builder = source.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  const sourceCell = hexGridBoundaryCells(source, "east")[11];
  assert.ok(sourceCell);
  const targetCell = hexGridHandoffTarget(source, sourceCell, "east");
  assert.ok(targetCell);
  const targetTile = target.tiles[targetCell.y * target.width + targetCell.x];
  assert.ok(targetTile);
  targetTile.terrain = "plain";
  delete targetTile.resource;
  target.structures = [];

  builder.autonomy = true;
  builder.position = { ...sourceCell };
  builder.inventory = { ...BUILD_RECIPES.camp.cost };
  if (marker !== undefined) builder.settlementMigrationOriginRegionId = marker;
  builder.task = {
    source: "autonomy",
    issuedAtTick: source.tick,
    type: "move",
    target: { ...sourceCell },
  };
  return { source, target, builder, targetCell };
}

function handoff(source, target, builder, targetCell) {
  const detached = detachAgentOwnership(source, [], builder.id);
  assert.equal(detached.ok, true);
  const attached = attachAgentOwnership(
    target,
    [],
    detached.value.agent,
    targetCell,
    source.regionId,
  );
  assert.equal(attached.ok, true);
  const globalId = globalHandoffAgentId(builder.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === globalId);
  assert.ok(arrived);
  return arrived;
}

test("camp-sized cargo does not manufacture migration intent on an unrelated builder handoff", () => {
  const { source, target, builder, targetCell } = crossingBuilder(undefined);
  const arrived = handoff(source, target, builder, targetCell);

  assert.deepEqual(arrived.inventory, BUILD_RECIPES.camp.cost);
  assert.equal(arrived.settlementMigrationOriginRegionId, undefined);
  assert.equal(arrived.task, undefined);
  assert.equal(arrived.status, "arrived from neighboring region");
});

test("a builder returning to its migration origin does not found a new frontier camp there", () => {
  const { source, target, builder, targetCell } = crossingBuilder("garden-2");
  const arrived = handoff(source, target, builder, targetCell);

  assert.deepEqual(arrived.inventory, BUILD_RECIPES.camp.cost);
  assert.equal(arrived.settlementMigrationOriginRegionId, target.regionId);
  assert.equal(arrived.task, undefined);
  assert.equal(arrived.status, "arrived from neighboring region");
});
