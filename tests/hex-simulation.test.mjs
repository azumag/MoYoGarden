import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance, hexGridNeighbors, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { flowTargetAt, simulate } from "../dist-ts/src/simulation.js";
import {
  createInitialWorld,
  getPerception,
  getTile,
  migrateWorldToHexGrid,
  validateWorldState,
} from "../dist-ts/src/world.js";

function resourceAmount(state, kind) {
  return state.tiles.reduce(
    (total, tile) => total + (tile.resource?.kind === kind ? tile.resource.amount : 0),
    0,
  );
}

test("new worlds keep rectangular storage but only hex cells participate in simulation", () => {
  const state = createInitialWorld({ seed: 6001, width: 40, height: 24 });
  assert.equal(state.tiles.length, 40 * 24);

  const active = state.tiles.filter((tile) => isHexGridCell(state, tile));
  const inactive = state.tiles.filter((tile) => !isHexGridCell(state, tile));
  assert.equal(active.length, 397);
  assert.ok(inactive.length > 0);
  assert.ok(inactive.every((tile) => tile.terrain === "water" && tile.resource === undefined));
  assert.ok(state.agents.every((agent) => isHexGridCell(state, agent.position)));
  assert.deepEqual(validateWorldState(state), []);
});

test("persisted rectangular corner state migrates deterministically into the active hex without losing resources", () => {
  const state = createInitialWorld({ seed: 6002, width: 40, height: 24 });
  const corner = state.tiles[0];
  assert.ok(corner);
  corner.terrain = "forest";
  corner.elevation = 0.7;
  corner.resource = { kind: "wood", amount: 9, maxAmount: 12 };

  const agent = state.agents[0];
  assert.ok(agent);
  agent.position = { x: 0, y: 0 };
  agent.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "move",
    target: { x: 0, y: 0 },
  };
  state.structures.push({
    id: "legacy-corner-camp",
    factionId: agent.factionId,
    type: "camp",
    position: { x: 0, y: 0 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  });

  // Persistence validation must accept the legacy rectangular envelope so the
  // region is migrated rather than reset before its first hex simulation tick.
  assert.deepEqual(validateWorldState(state), []);
  const woodBefore = resourceAmount(state, "wood");

  const changed = migrateWorldToHexGrid(state);
  assert.ok(changed > 0);
  assert.equal(corner.terrain, "water");
  assert.equal(corner.resource, undefined);
  assert.equal(resourceAmount(state, "wood"), woodBefore);
  assert.ok(isHexGridCell(state, agent.position));
  assert.equal(getTile(state, agent.position)?.terrain === "water", false);
  assert.equal(agent.task, undefined);
  const camp = state.structures.find((entry) => entry.id === "legacy-corner-camp");
  assert.ok(camp);
  assert.ok(isHexGridCell(state, camp.position));
  assert.deepEqual(validateWorldState(state), []);
});

test("movement reaches an axial diagonal neighbor in one simulation tick", () => {
  const state = createInitialWorld({ seed: 6003, width: 40, height: 24 });
  const agent = state.agents[0];
  assert.ok(agent);
  const center = { x: 19, y: 11 };
  const target = { x: 20, y: 10 };
  for (const position of [center, target]) {
    const tile = state.tiles[position.y * state.width + position.x];
    assert.ok(tile);
    tile.terrain = "plain";
    delete tile.resource;
  }
  agent.position = center;
  agent.autonomy = false;
  delete agent.task;

  const result = simulate(state, [{
    id: "hex-one-step",
    agentId: agent.id,
    submittedAtTick: state.tick,
    type: "move",
    target,
  }]);
  const moved = result.state.agents.find((entry) => entry.id === agent.id);
  assert.ok(moved);
  assert.deepEqual(moved.position, target);
  assert.equal(hexGridDistance(center, target), 1);
});

test("hydrology chooses only one of the six equidistant hex neighbors", () => {
  const state = createInitialWorld({ seed: 6004, width: 40, height: 24 });
  const center = { x: 19, y: 11 };
  const source = state.tiles[center.y * state.width + center.x];
  assert.ok(source);
  source.terrain = "plain";
  source.elevation = 0.8;

  for (const neighbor of hexGridNeighbors(center)) {
    const tile = state.tiles[neighbor.y * state.width + neighbor.x];
    assert.ok(tile);
    tile.terrain = "plain";
    tile.elevation = 0.75;
  }
  const northEast = { x: 20, y: 10 };
  const neTile = state.tiles[northEast.y * state.width + northEast.x];
  assert.ok(neTile);
  neTile.elevation = 0.4;

  const squareOnlyDiagonal = { x: 20, y: 12 };
  assert.equal(hexGridDistance(center, squareOnlyDiagonal), 2);
  const diagonalTile = state.tiles[squareOnlyDiagonal.y * state.width + squareOnlyDiagonal.x];
  assert.ok(diagonalTile);
  diagonalTile.terrain = "plain";
  diagonalTile.elevation = 0.05;

  assert.deepEqual(flowTargetAt(state, center), northEast);
});

test("perception radius one is the center plus six axial neighbors", () => {
  const state = createInitialWorld({ seed: 6005, width: 40, height: 24 });
  const agent = state.agents[0];
  assert.ok(agent);
  agent.position = { x: 19, y: 11 };
  const perception = getPerception(state, agent.id, 1);
  assert.equal(perception.visibleTiles.length, 7);
  assert.ok(perception.visibleTiles.every((tile) => hexGridDistance(tile, agent.position) <= 1));
});
