import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { hasLocalSpacedCampSite } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("settlement migration ignores non-water compatibility cells outside the active hex", () => {
  const state = createInitialWorld({ seed: 130926, width: 40, height: 24 });
  for (const tile of state.tiles) {
    tile.terrain = "water";
    delete tile.resource;
  }

  const anchor = state.tiles.find((tile) =>
    isHexGridCell(state, tile)
    && state.tiles.some((candidate) =>
      !isHexGridCell(state, candidate)
      && hexGridDistance(tile, candidate) >= 2
      && hexGridDistance(tile, candidate) <= 5
    )
  );
  assert.ok(anchor, "fixture needs an active boundary cell near the compatibility envelope");
  anchor.terrain = "plain";

  const inactiveCandidate = state.tiles.find((tile) =>
    !isHexGridCell(state, tile)
    && hexGridDistance(anchor, tile) >= 2
    && hexGridDistance(anchor, tile) <= 5
  );
  assert.ok(inactiveCandidate);
  inactiveCandidate.terrain = "plain";

  const factionId = state.factions[0]?.id;
  assert.ok(factionId);
  state.structures = [{
    id: "edge-camp",
    factionId,
    type: "camp",
    position: { x: anchor.x, y: anchor.y },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];

  assert.equal(
    hasLocalSpacedCampSite(state, factionId),
    false,
    "inactive 40x24 compatibility cells must not suppress region migration",
  );

  const activeCandidate = state.tiles.find((tile) =>
    isHexGridCell(state, tile)
    && hexGridDistance(anchor, tile) >= 2
    && hexGridDistance(anchor, tile) <= 5
    && (tile.x !== anchor.x || tile.y !== anchor.y)
  );
  assert.ok(activeCandidate);
  activeCandidate.terrain = "plain";

  assert.equal(
    hasLocalSpacedCampSite(state, factionId),
    true,
    "an actual active-hex camp site should still keep expansion local",
  );
});
