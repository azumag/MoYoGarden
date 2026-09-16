import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  environmentalMoisture,
  environmentalRelief,
  environmentalTerrainColor,
} from "../public/client/terrain.js";

function tile(x, y, elevation = 0.5, terrain = "plain") {
  return { x, y, elevation, terrain };
}

function lookup(entries) {
  const byPosition = new Map(entries.map((entry) => [`${entry.x}:${entry.y}`, entry]));
  return (x, y) => byPosition.get(`${x}:${y}`) ?? null;
}

test("terrain relief uses the six axial neighbors rather than square diagonals", () => {
  const center = tile(0, 0, 0.5);
  const squareOnlyDiagonal = tile(1, 1, 1);
  assert.equal(environmentalRelief(lookup([center, squareOnlyDiagonal]), center), 0);

  const axialNeighbor = tile(1, -1, 1);
  assert.equal(environmentalRelief(lookup([center, axialNeighbor]), center), 1);
});

test("environment tint responds to low-level water moisture on the hex metric", () => {
  const center = tile(0, 0, 0.35);
  const dryLookup = lookup([center]);
  const wetLookup = lookup([center, tile(1, -1, 0, "water")]);

  const dryMoisture = environmentalMoisture(dryLookup, center);
  const wetMoisture = environmentalMoisture(wetLookup, center);
  assert.ok(wetMoisture > dryMoisture);
  assert.notEqual(
    environmentalTerrainColor(wetLookup, center).getHex(),
    environmentalTerrainColor(dryLookup, center).getHex(),
  );
});

test("active hex terrain renderer consumes the shared environmental tint", async () => {
  const source = await readFile(
    new URL("../public/client/hex-tile-rendering.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /environmentalTerrainColor\(stateTile, tile\)/);
  assert.match(source, /const color = tileColor\(stateTile, tile\)/);
});


test("neighbor preview derives land tint from each chunk environment", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function buildNeighborPreview");
  const end = source.indexOf("async function loadTerrainWindow", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(source, /import \{ environmentalTerrainColor \} from "\.\/client\/terrain\.js"/);
  assert.match(body, /const chunkStateTile = \(x, y\) =>/);
  assert.match(body, /environmentalTerrainColor\(chunkStateTile, tile\)/);
});
