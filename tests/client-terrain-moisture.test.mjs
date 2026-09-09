import assert from "node:assert/strict";
import test from "node:test";
import { environmentalMoisture } from "../public/client/terrain.js";

const target = {
  x: 10,
  y: 10,
  terrain: "plain",
  elevation: 0.5,
  drainage: 0,
};

function moistureWithWaterAt(x, y) {
  const stateTile = (tileX, tileY) => {
    if (tileX === x && tileY === y) return { x, y, terrain: "water" };
    return null;
  };
  return environmentalMoisture(stateTile, target);
}

test("terrain moisture tint gives all six adjacent hexes equal water influence", () => {
  const east = moistureWithWaterAt(11, 10);
  const northEast = moistureWithWaterAt(11, 9);
  const northWest = moistureWithWaterAt(10, 9);
  const west = moistureWithWaterAt(9, 10);
  const southWest = moistureWithWaterAt(9, 11);
  const southEast = moistureWithWaterAt(10, 11);

  assert.ok(east > moistureWithWaterAt(20, 20));
  assert.equal(northEast, east);
  assert.equal(northWest, east);
  assert.equal(west, east);
  assert.equal(southWest, east);
  assert.equal(southEast, east);
});

test("terrain moisture tint uses axial distance beyond the immediate ring", () => {
  assert.equal(
    moistureWithWaterAt(12, 8),
    moistureWithWaterAt(12, 10),
    "two-step axial diagonal water should tint the ground like any other distance-two water",
  );
});
