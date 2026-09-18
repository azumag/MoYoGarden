import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_GRID_DIRECTION_STEPS,
  hexGridNeighbors,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { applyPathogenSteps, tilePathogenReservoir } from "../dist-ts/src/pathogen.js";
import { sampleWorldWind } from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function cleanReservoirState() {
  const state = createInitialWorld({ seed: 260918, width: 40, height: 24 });
  state.agents = [];
  for (const tile of state.tiles) {
    delete tile.pathogenReservoir;
    delete tile.flowTo;
    tile.drainage = 0;
  }
  return state;
}

const environment = { worldSeed: 424242, originX: 0, originY: 0 };

test("shared-world wind carries environmental pathogen burden one local hex downwind", () => {
  const state = cleanReservoirState();
  const control = structuredClone(state);
  const source = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  const controlSource = control.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  assert.ok(source);
  assert.ok(controlSource);
  source.pathogenReservoir = 1;
  controlSource.pathogenReservoir = 1;

  const wind = sampleWorldWind(
    environment.worldSeed,
    environment.originX + source.x,
    environment.originY + source.y,
  );
  const step = HEX_GRID_DIRECTION_STEPS[wind.direction];
  const targetPosition = { x: source.x + step.x, y: source.y + step.y };
  const target = state.tiles.find(
    (tile) => tile.x === targetPosition.x && tile.y === targetPosition.y,
  );
  assert.ok(target);
  assert.equal(isHexGridCell(state, target), true);

  applyPathogenSteps(state, 1, environment);
  applyPathogenSteps(control, 1);

  assert.ok(
    tilePathogenReservoir(target) > 0,
    "wind should move some existing environmental burden downwind",
  );
  const controlTarget = control.tiles.find(
    (tile) => tile.x === targetPosition.x && tile.y === targetPosition.y,
  );
  assert.ok(controlTarget);
  assert.equal(
    tilePathogenReservoir(controlTarget),
    0,
    "without the shared environment frame there is no wind transport",
  );

  const otherNeighbors = hexGridNeighbors(source).filter(
    (position) => position.x !== targetPosition.x || position.y !== targetPosition.y,
  );
  for (const position of otherNeighbors) {
    const tile = state.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
    assert.ok(tile);
    assert.equal(
      tilePathogenReservoir(tile),
      0,
      "a single pathogen step must follow only the sampled downwind edge",
    );
  }

  const total = state.tiles.reduce((sum, tile) => sum + tilePathogenReservoir(tile), 0);
  assert.ok(total > 0 && total < 1, "clearance may remove burden but wind must not create it");
});

test("wind transport fails soft at an unresolved macro-hex boundary", () => {
  const state = cleanReservoirState();
  const source = state.tiles.find((tile) => {
    if (!isHexGridCell(state, tile)) return false;
    const wind = sampleWorldWind(
      environment.worldSeed,
      environment.originX + tile.x,
      environment.originY + tile.y,
    );
    const step = HEX_GRID_DIRECTION_STEPS[wind.direction];
    return !isHexGridCell(state, { x: tile.x + step.x, y: tile.y + step.y });
  });
  assert.ok(source, "fixture should find a boundary cell whose wind points outside the active hex");
  source.pathogenReservoir = 1;

  applyPathogenSteps(state, 1, environment);

  const contaminated = state.tiles.filter(
    (tile) => isHexGridCell(state, tile) && tilePathogenReservoir(tile) > 0,
  );
  assert.deepEqual(
    contaminated.map((tile) => [tile.x, tile.y]),
    [[source.x, source.y]],
    "unowned downwind cells must not receive copied reservoir burden",
  );
  assert.ok(tilePathogenReservoir(source) > 0);
});
