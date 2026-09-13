import assert from "node:assert/strict";
import test from "node:test";
import { hexGridDistance, isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { hasLocalSpacedCampSite } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("local expansion can use free space around any active faction camp", () => {
  const state = createInitialWorld({ seed: 260913, width: 40, height: 24 });
  const faction = state.factions[0];
  assert.ok(faction);

  const firstCampPosition = { x: 19, y: 11 };
  const secondCampPosition = { x: 25, y: 11 };
  const candidatePosition = { x: 27, y: 11 };

  assert.ok(hexGridDistance(candidatePosition, firstCampPosition) > 5);
  assert.equal(hexGridDistance(candidatePosition, secondCampPosition), 2);

  for (const tile of state.tiles) {
    if (isHexGridCell(state, tile)) tile.terrain = "water";
  }
  for (const position of [firstCampPosition, secondCampPosition, candidatePosition]) {
    const tile = state.tiles[position.y * state.width + position.x];
    assert.ok(tile);
    assert.equal(isHexGridCell(state, tile), true);
    tile.terrain = "plain";
    delete tile.resource;
  }

  state.structures = [
    {
      id: "camp-a",
      factionId: faction.id,
      type: "camp",
      position: firstCampPosition,
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 0, stone: 0, food: 0 },
    },
    {
      id: "camp-b",
      factionId: faction.id,
      type: "camp",
      position: secondCampPosition,
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 0, stone: 0, food: 0 },
    },
  ];

  assert.equal(
    hasLocalSpacedCampSite(state, faction.id),
    true,
    "a valid site near the second camp must prevent unnecessary cross-region migration",
  );
});
