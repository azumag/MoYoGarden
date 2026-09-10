import assert from "node:assert/strict";
import test from "node:test";
import { nearSettlement, wetnessHint } from "../public/client/decay-dressing.js";

function makeHexState(width = 7, height = 7) {
  return {
    width,
    height,
    tiles: Array.from({ length: width * height }, (_, index) => ({
      x: index % width,
      y: Math.floor(index / width),
      terrain: "plain",
      drainage: 0,
    })),
    structures: [],
  };
}

test("decay wetness uses axial hex distance around water", () => {
  const state = makeHexState();
  const tile = state.tiles[3 * state.width + 3];
  const water = state.tiles[1 * state.width + 5];
  assert.ok(tile);
  assert.ok(water);

  // (2,-2) is two axial hex steps away but four Manhattan grid steps away.
  water.terrain = "water";

  assert.equal(wetnessHint(state, tile), 0.36);
});

test("decay settlement exclusion radius follows the same axial hex metric", () => {
  const state = makeHexState();
  const tile = state.tiles[3 * state.width + 3];
  assert.ok(tile);
  state.structures.push({ position: { x: 5, y: 1 } });

  // The structure is hex-distance 2 from the tile, so the default 2.2 radius
  // should treat it as nearby even though rectangular Euclidean distance is > 2.2.
  assert.equal(nearSettlement(state, tile), true);
});