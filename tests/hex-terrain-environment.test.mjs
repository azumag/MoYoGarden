import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createTerrainWindowTileLookup,
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

test("terrain window lookup carries water influence across a macro-region seam", () => {
  const source = tile(30, 11, 0.35);
  const remoteWater = tile(8, 22, 0, "water");
  const chunks = [
    {
      regionId: "hex-q0-r0",
      globalCellOrigin: { x: -19, y: -11 },
      state: { width: 40, height: 24, tiles: [source] },
    },
    {
      regionId: "hex-q1-r0",
      // This synthetic origin maps the remote active cell to the exact
      // global E neighbor of source while keeping local coordinates distinct.
      globalCellOrigin: { x: 4, y: -22 },
      state: { width: 40, height: 24, tiles: [remoteWater] },
    },
  ];
  const windowTile = createTerrainWindowTileLookup(chunks);
  const sourceLookup = (x, y) => windowTile(chunks[0], x, y);
  assert.equal(sourceLookup(31, 11), remoteWater);
  assert.ok(
    environmentalMoisture(sourceLookup, source)
      > environmentalMoisture(lookup([source]), source),
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
  assert.match(source, /createTerrainWindowTileLookup, environmentalTerrainColor/);
  assert.match(body, /const windowStateTile = createTerrainWindowTileLookup\(chunks\)/);
  assert.match(body, /const chunkStateTile = \(x, y\) => windowStateTile\(chunk, x, y\)/);
  assert.match(body, /environmentalTerrainColor\(chunkStateTile, tile\)/);
});
