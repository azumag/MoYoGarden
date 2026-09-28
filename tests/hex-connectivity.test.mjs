import assert from "node:assert/strict";
import test from "node:test";
import { passableHexComponentByPosition } from "../dist-ts/src/hex-connectivity.js";
import { hexGridCells } from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function plainWorld() {
  const state = createInitialWorld({ seed: 424242, regionId: "garden-1" });
  for (const tile of state.tiles) {
    if (hexGridCells(state).some((cell) => cell.x === tile.x && cell.y === tile.y)) {
      tile.terrain = "plain";
    }
  }
  return state;
}

test("passable component labels cover the full active hex deterministically", () => {
  const state = plainWorld();
  const labels = passableHexComponentByPosition(state);
  assert.equal(labels.size, 397);
  assert.equal(new Set(labels.values()).size, 1);

  const reversed = structuredClone(state);
  reversed.tiles.reverse();
  assert.deepEqual(
    [...passableHexComponentByPosition(reversed).entries()].sort(),
    [...labels.entries()].sort(),
  );
});

test("water barrier splits active hex components and water cells stay unlabeled", () => {
  const state = plainWorld();
  for (const tile of state.tiles) {
    if (tile.x === 19) tile.terrain = "water";
  }
  const labels = passableHexComponentByPosition(state);
  assert.equal(new Set(labels.values()).size, 2);
  assert.ok([...labels.keys()].every((key) => !key.startsWith("19,")));

  const sizes = new Map();
  for (const component of labels.values()) {
    sizes.set(component, (sizes.get(component) ?? 0) + 1);
  }
  assert.deepEqual([...sizes.values()].sort((a, b) => a - b), [187, 187]);
});

test("component id is the minimum linear index in each component", () => {
  const state = plainWorld();
  for (const tile of state.tiles) {
    if (tile.x === 19) tile.terrain = "water";
  }
  const labels = passableHexComponentByPosition(state);
  const positionsByComponent = new Map();
  for (const [key, component] of labels) {
    const [x, y] = key.split(",").map(Number);
    const values = positionsByComponent.get(component) ?? [];
    values.push(y * state.width + x);
    positionsByComponent.set(component, values);
  }
  for (const [component, indexes] of positionsByComponent) {
    assert.equal(component, Math.min(...indexes));
  }
});
