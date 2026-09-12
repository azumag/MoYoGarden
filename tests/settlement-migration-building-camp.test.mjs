import assert from "node:assert/strict";
import test from "node:test";
import {
  planAutonomousSettlementMigration,
  shouldScoutSettlementMigration,
} from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function arrivedPioneerWithBuildingCamp() {
  const state = createInitialWorld({ seed: 260913, width: 40, height: 24 });
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);

  state.tick = 25;
  state.agents = [builder];
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
  state.structures = [{
    id: "arrival-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { x: 20, y: 11 },
    status: "building",
    progress: 2,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];

  return { state, builder };
}

test("an arriving pioneer stays to assist an existing faction camp under construction", () => {
  const { state, builder } = arrivedPioneerWithBuildingCamp();
  const richerNeighborHalo = [{
    direction: "E",
    sourcePosition: { x: 30, y: 11 },
    neighborRegionId: "hex-q1-r0",
    neighborPosition: { x: 8, y: 11 },
    tile: {
      x: 8,
      y: 11,
      terrain: "plain",
      elevation: 0.5,
      resource: { kind: "food", amount: 20, maxAmount: 40 },
    },
  }];

  assert.notEqual(state.tick % 12, 0, "fixture must exercise the immediate-arrival scout path");
  assert.equal(
    shouldScoutSettlementMigration(state),
    false,
    "a same-faction camp already being built is a settlement anchor, not a transit-only region",
  );
  assert.equal(
    planAutonomousSettlementMigration(state, richerNeighborHalo),
    undefined,
    "the pioneer must not leave an in-progress same-faction camp for a richer neighboring region",
  );
  assert.equal(builder.task?.type, "build");
  assert.equal(builder.task?.structureType, "camp");
});
