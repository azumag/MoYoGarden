import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { resourceRegrowthChanceWithHalo } from "../dist-ts/src/halo-environment.js";
import { resourceRegrowthChance } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("missing halo edge does not treat inactive storage-envelope biomass as a local propagule", () => {
  const state = createInitialWorld({ seed: 9302, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
    tile.elevation = 0.8;
    tile.drainage = 0;
    delete tile.flowTo;
    tile.erosionPressure = 0;
  }

  let receiver;
  let inactiveNeighbor;
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    for (const direction of HEX_GRID_DIRECTIONS) {
      const step = HEX_GRID_DIRECTION_STEPS[direction];
      const position = { x: tile.x + step.x, y: tile.y + step.y };
      if (
        position.x < 0 || position.y < 0 ||
        position.x >= state.width || position.y >= state.height ||
        isHexGridCell(state, position)
      ) {
        continue;
      }
      receiver = tile;
      inactiveNeighbor = state.tiles[position.y * state.width + position.x];
      break;
    }
    if (receiver !== undefined) break;
  }

  assert.ok(receiver, "expected an active boundary cell next to a compatibility-envelope cell");
  assert.ok(inactiveNeighbor, "expected the compatibility-envelope tile to remain in storage");
  receiver.resource = { kind: "wood", amount: 0, maxAmount: 10 };
  inactiveNeighbor.resource = { kind: "wood", amount: 10, maxAmount: 10 };

  const localChance = resourceRegrowthChance(state, receiver);
  assert.equal(
    resourceRegrowthChanceWithHalo(state, receiver, []),
    localChance,
    "an unavailable cross-region halo must stay unknown instead of borrowing biomass from inactive 40x24 storage",
  );
});
