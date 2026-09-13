import assert from "node:assert/strict";
import test from "node:test";
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
