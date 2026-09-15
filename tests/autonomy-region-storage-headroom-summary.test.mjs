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
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 150926, width: 40, height: 24, regionId: "garden-1" });
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
  agent.task = { source: "autonomy", issuedAtTick: 20, type: "gather", resource: "wood" };
  return { state, agent };
}

function halo(state, direction, regionId, factionId, headroom) {
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
    tile: {
      x: neighborPosition.x,
      y: neighborPosition.y,
      terrain: "plain",
      resource: { kind: "wood", amount: 8, maxAmount: 8 },
    },
    neighborRegionSummary: {
      resources: { wood: 8, stone: 0, food: 0 },
      passableCells: 397,
      occupants: 1,
      ...(headroom === undefined ? {} : { storageHeadroomByFaction: { [factionId]: headroom } }),
    },
  };
}

test("materialized halo carries bounded faction storage headroom without mutating the snapshot", () => {
  const summary = {
    resources: { wood: 8, stone: 0, food: 0 },
    storageHeadroomByFaction: { settlers: 0, traders: 12 },
    passableCells: 397,
    occupants: 2,
  };
  const link = {
    sourceRegionId: "garden-1", sourcePosition: { x: 30, y: 11 }, direction: "east",
    neighborRegionId: "garden-2", neighborPosition: { x: 8, y: 11 }, neighborDirection: "west",
  };
  const materialized = materializeHexHalo([link], [{
    regionId: "garden-2", direction: "west", revision: 1, tick: 10, regionSummary: summary,
    tiles: [{ position: { x: 8, y: 11 }, tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 } }],
  }]);
  assert.deepEqual(materialized[0].neighborRegionSummary?.storageHeadroomByFaction, { settlers: 0, traders: 12 });
  materialized[0].neighborRegionSummary.storageHeadroomByFaction.settlers = 1;
  assert.equal(summary.storageHeadroomByFaction.settlers, 0);
});

test("equivalent resource expeditions prefer own-faction destination storage headroom", () => {
  const { state, agent } = fixture();
  const east = halo(state, "east", "garden-2", agent.factionId, 0);
  const west = halo(state, "west", "hex-q-1-r0", agent.factionId, 10);
  const plan = planAutonomousHaloTravel(state, [east, west]);
  assert.ok(plan);
  assert.equal(plan.direction, "west");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});

test("equivalent expeditions prefer unknown storage over a destination known to be full", () => {
  const { state, agent } = fixture();
  const east = halo(state, "east", "garden-2", agent.factionId, 0);
  const west = halo(state, "west", "hex-q-1-r0", agent.factionId, undefined);
  const plan = planAutonomousHaloTravel(state, [east, west]);
  assert.ok(plan);
  assert.equal(plan.direction, "west");
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
});

test("storage headroom for another faction does not bias expedition routing", () => {
  const { state, agent } = fixture();
  const east = halo(state, "east", "garden-2", agent.factionId, undefined);
  const west = halo(state, "west", "hex-q-1-r0", "other-faction", 20);
  const plan = planAutonomousHaloTravel(state, [west, east]);
  assert.ok(plan);
  assert.equal(plan.direction, "east", "legacy deterministic route order should remain when own-faction headroom is unknown");
});


function fillFactionStorage(state, factionId) {
  for (const structure of state.structures) {
    if (structure.factionId !== factionId || structure.status !== "active") continue;
    structure.storage = {
      wood: BUILD_RECIPES[structure.type].storageCapacity,
      stone: 0,
      food: 0,
    };
  }
}

test("known-full destination is rejected when the source has no return storage", () => {
  const { state, agent } = fixture();
  fillFactionStorage(state, agent.factionId);
  const east = halo(state, "east", "garden-2", agent.factionId, 0);
  const plan = planAutonomousHaloTravel(state, [east]);
  assert.equal(plan, undefined);
});

test("unknown destination remains eligible when the source has no return storage", () => {
  const { state, agent } = fixture();
  fillFactionStorage(state, agent.factionId);
  const east = halo(state, "east", "garden-2", agent.factionId, undefined);
  const plan = planAutonomousHaloTravel(state, [east]);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "garden-2");
});

test("known-full destination remains eligible when source return capacity exists", () => {
  const { state, agent } = fixture();
  fillFactionStorage(state, agent.factionId);
  state.structures.push({
    id: "expedition-return-buffer",
    factionId: agent.factionId,
    type: "storehouse",
    position: hexGridCenter(state),
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: { wood: 0, stone: 0, food: 0 },
  });
  const east = halo(state, "east", "garden-2", agent.factionId, 0);
  const plan = planAutonomousHaloTravel(state, [east]);
  assert.ok(plan);
  assert.equal(plan.neighborRegionId, "garden-2");
});
