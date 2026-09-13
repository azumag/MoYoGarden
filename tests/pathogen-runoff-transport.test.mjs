import assert from "node:assert/strict";
import test from "node:test";
import { hexGridNeighbors } from "../dist-ts/src/hex-grid.js";
import { applyPathogenSteps, tilePathogenReservoir } from "../dist-ts/src/pathogen.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function cleanReservoirState() {
  const state = createInitialWorld({ seed: 260913, width: 40, height: 24 });
  state.agents = [];
  for (const tile of state.tiles) {
    delete tile.pathogenReservoir;
    delete tile.flowTo;
    tile.drainage = 0;
  }
  return state;
}

test("pathogen reservoir follows an existing local runoff edge without creating burden", () => {
  const state = cleanReservoirState();
  const source = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  const target = state.tiles.find((tile) => tile.x === 20 && tile.y === 11);
  assert.ok(source);
  assert.ok(target);
  source.pathogenReservoir = 1;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 1;

  const changed = applyPathogenSteps(state, 1);
  const sourceAfter = tilePathogenReservoir(source);
  const targetAfter = tilePathogenReservoir(target);

  assert.ok(changed > 0);
  assert.ok(targetAfter > 0, "runoff should carry some environmental burden downstream");
  assert.ok(sourceAfter < 0.82, "transport should remove burden before the normal 18% clearance");
  assert.ok(
    Math.abs(sourceAfter + targetAfter - 0.82) < 1e-9,
    "runoff transfer must conserve burden before uniform clearance",
  );
});

test("unresolved cross-region runoff outlets stay local and fail soft", () => {
  const state = cleanReservoirState();
  const source = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  assert.ok(source);
  source.pathogenReservoir = 1;
  source.flowTo = { x: 999, y: 999 };
  source.drainage = 1;

  applyPathogenSteps(state, 1);
  assert.ok(Math.abs(tilePathogenReservoir(source) - 0.82) < 1e-9);
  const total = state.tiles.reduce((sum, tile) => sum + tilePathogenReservoir(tile), 0);
  assert.ok(Math.abs(total - 0.82) < 1e-9);
});

function convergingRunoffState(reverseTiles = false) {
  const state = cleanReservoirState();
  const target = state.tiles.find((tile) => tile.x === 19 && tile.y === 11);
  assert.ok(target);
  const neighborPositions = hexGridNeighbors(target);
  assert.ok(neighborPositions.length >= 2);
  const sourceA = state.tiles.find(
    (tile) => tile.x === neighborPositions[0].x && tile.y === neighborPositions[0].y,
  );
  const sourceB = state.tiles.find(
    (tile) => tile.x === neighborPositions[1].x && tile.y === neighborPositions[1].y,
  );
  assert.ok(sourceA);
  assert.ok(sourceB);

  target.pathogenReservoir = 0.95;
  for (const source of [sourceA, sourceB]) {
    source.pathogenReservoir = 1;
    source.flowTo = { x: target.x, y: target.y };
    source.drainage = 1;
  }
  if (reverseTiles) state.tiles.reverse();
  return {
    state,
    targetPosition: { x: target.x, y: target.y },
    sourceAPosition: { x: sourceA.x, y: sourceA.y },
    sourceBPosition: { x: sourceB.x, y: sourceB.y },
  };
}

test("converging runoff shares downstream pathogen capacity independent of tile order", () => {
  const forward = convergingRunoffState(false);
  const reversed = convergingRunoffState(true);
  applyPathogenSteps(forward.state, 1);
  applyPathogenSteps(reversed.state, 1);

  const reservoirAt = (state, position) => {
    const tile = state.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
    assert.ok(tile);
    return tilePathogenReservoir(tile);
  };

  const forwardA = reservoirAt(forward.state, forward.sourceAPosition);
  const forwardB = reservoirAt(forward.state, forward.sourceBPosition);
  const reversedA = reservoirAt(reversed.state, reversed.sourceAPosition);
  const reversedB = reservoirAt(reversed.state, reversed.sourceBPosition);
  const forwardTarget = reservoirAt(forward.state, forward.targetPosition);
  const reversedTarget = reservoirAt(reversed.state, reversed.targetPosition);

  assert.ok(Math.abs(forwardA - forwardB) < 1e-9, "equal tributaries should share capacity equally");
  assert.ok(Math.abs(forwardA - reversedA) < 1e-9, "source A must not depend on tile ordering");
  assert.ok(Math.abs(forwardB - reversedB) < 1e-9, "source B must not depend on tile ordering");
  assert.ok(Math.abs(forwardA - 0.7995) < 1e-9);
  assert.ok(Math.abs(forwardTarget - 0.82) < 1e-9);
  assert.ok(Math.abs(reversedTarget - forwardTarget) < 1e-9);

  for (const state of [forward.state, reversed.state]) {
    const total = state.tiles.reduce((sum, tile) => sum + tilePathogenReservoir(tile), 0);
    assert.ok(Math.abs(total - 2.419) < 1e-9, "converging runoff must conserve total burden");
  }
});
