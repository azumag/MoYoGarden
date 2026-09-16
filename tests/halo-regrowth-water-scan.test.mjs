import assert from "node:assert/strict";
import test from "node:test";
import { applyHaloRegrowthCompensation } from "../dist-ts/src/halo-environment.js";
import { buildDynamicHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("halo regrowth indexes water ghosts once per compensation pass", () => {
  const before = createInitialWorld({ seed: 9408, width: 40, height: 24, regionId: "garden-1" });
  const after = structuredClone(before);

  for (const state of [before, after]) {
    for (const tile of state.tiles) {
      if (tile.resource?.kind === "wood" || tile.resource?.kind === "food") {
        tile.resource.amount = tile.resource.maxAmount;
      }
    }
  }

  let prepared = 0;
  for (let index = 0; index < after.tiles.length && prepared < 16; index += 1) {
    const current = after.tiles[index];
    const previous = before.tiles[index];
    if (current === undefined || previous === undefined) continue;
    if (!isHexGridCell(after, current) || current.terrain === "water") continue;
    current.resource = { kind: "wood", amount: 0, maxAmount: 10 };
    previous.resource = { kind: "wood", amount: 0, maxAmount: 10 };
    prepared += 1;
  }
  assert.equal(prepared, 16);
  before.tick = 29;
  after.tick = 30;

  const link = buildDynamicHexHaloLinks(after, "garden-1")[0];
  assert.ok(link);
  let terrainReads = 0;
  const ghostTile = {
    x: link.neighborPosition.x,
    y: link.neighborPosition.y,
    elevation: 0.5,
    drainage: 0,
    get terrain() {
      terrainReads += 1;
      return "water";
    },
  };

  applyHaloRegrowthCompensation(before, after, [{ ...link, tile: ghostTile }], 30);

  assert.ok(
    terrainReads <= 3,
    `water classification should be indexed once for the pass, got ${terrainReads} terrain reads`,
  );
});
