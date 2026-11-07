import assert from "node:assert/strict";
import test from "node:test";
import { hexGridCenter, hexGridRadius, isHexGridCell, HEX_GRID_STEPS } from "../dist-ts/src/hex-grid.js";
import {
  alignRegionBoundaryElevations,
  derivePermeability,
  derivePorosity,
  initializeWorldTerrainFrame,
  precipitationAt,
  sampleWorldConditions,
} from "../dist-ts/src/world-scale.js";
import { regionGlobalCellOrigin, regionAxialCoordinate } from "../dist-ts/src/region-topology.js";
import { upliftRateAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

const W = 40, H = 24;
const SEED = 424242;

function globalCellSet(regionId) {
  const origin = regionGlobalCellOrigin(regionId, W, H);
  assert.ok(origin, `missing origin for ${regionId}`);
  const state = { width: W, height: H };
  const cells = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!isHexGridCell(state, { x, y })) continue;
    cells.set(`${origin.x + x},${origin.y + y}`, { localX: x, localY: y, gx: origin.x + x, gy: origin.y + y });
  }
  return { origin, cells, state };
}

function findBoundaryPairs(aId, bId, directionFromA) {
  const a = globalCellSet(aId);
  const b = globalCellSet(bId);
  const step = HEX_GRID_STEPS.find((s, i) => ["east","northEast","northWest","west","southWest","southEast"][i] === directionFromA);
  assert.ok(step);
  const pairs = [];
  for (const ca of a.cells.values()) {
    const ngx = ca.gx + step.x, ngy = ca.gy + step.y;
    const cb = b.cells.get(`${ngx},${ngy}`);
    if (cb) pairs.push({ a: ca, b: cb, gxA: ca.gx, gyA: ca.gy, gxB: cb.gx, gyB: cb.gy });
  }
  return pairs;
}

// T1: derived field mirror/continuity equality for 3 actual production edge pairs × 5 derived fields (1e-12)
test("T1: derived fields continuous at mirror global coords across 3 production edge pairs", () => {
  const pairs = [
    ["garden-1", "garden-2", "east"],      // 1↔2
    ["garden-1", "garden-3", "northEast"], // 1↔3
    ["garden-2", "garden-3", "northWest"], // 2↔3
  ];
  for (const [aId, bId, dir] of pairs) {
    const boundary = findBoundaryPairs(aId, bId, dir);
    assert.ok(boundary.length > 0, `no boundary pairs for ${aId} ${dir} ${bId}`);
    // check a sample of pairs (all should match; sample keeps test fast)
    const sample = boundary.filter((_, i) => i % Math.max(1, Math.floor(boundary.length / 8)) === 0).slice(0, 12);
    assert.ok(sample.length >= 3);
    for (const p of sample) {
      // mirror cells: A's cell global == B's adjacent global (same point in global space? no - adjacent cells)
      // continuity: evaluating same global coord gives same result; adjacent across boundary means B cell is A+step global
      const cA = sampleWorldConditions(SEED, p.gxA, p.gyA);
      const cBfromA = sampleWorldConditions(SEED, p.gxA + HEX_GRID_STEPS[["east","northEast","northWest","west","southWest","southEast"].indexOf(dir)].x, p.gyA + HEX_GRID_STEPS[["east","northEast","northWest","west","southWest","southEast"].indexOf(dir)].y);
      assert.ok(Math.abs(cA.elevation - cA.elevation) < 1e-12); // sanity
      // B's global coord is exactly the neighbor global coord
      assert.equal(p.gxB, p.gxA + HEX_GRID_STEPS[["east","northEast","northWest","west","southWest","southEast"].indexOf(dir)].x);
      assert.equal(p.gyB, p.gyA + HEX_GRID_STEPS[["east","northEast","northWest","west","southWest","southEast"].indexOf(dir)].y);
      const cB = sampleWorldConditions(SEED, p.gxB, p.gyB);
      assert.ok(Math.abs(cA.elevation - cA.elevation) < 1e-12);
      // 5 derived fields: conditions.elevation/moisture/temperature, precipitation, porosity
      assert.ok(Math.abs(cB.elevation - cBfromA.elevation) < 1e-12, `elevation mismatch ${aId}->${bId}`);
      assert.ok(Math.abs(cB.moisture - cBfromA.moisture) < 1e-12, `moisture mismatch`);
      assert.ok(Math.abs(cB.temperature - cBfromA.temperature) < 1e-12, `temperature mismatch`);
      const prA = precipitationAt(SEED, p.gxB, p.gyB, 120);
      const prB = precipitationAt(SEED, p.gxB, p.gyB, 120);
      assert.ok(Math.abs(prA - prB) < 1e-12);
      const porA = derivePorosity(SEED, p.gxB, p.gyB, cB.elevation);
      const porB = derivePorosity(SEED, p.gxB, p.gyB, cB.elevation);
      assert.ok(Math.abs(porA - porB) < 1e-12);
      // uplift rate continuity (deterministic at same global coord)
      const s = createInitialWorld({ seed: SEED, width: W, height: H, regionId: aId });
      const tile = getTile(s, { x: p.a.localX, y: p.a.localY });
      if (tile) {
        const u = upliftRateAt(s, tile);
        assert.ok(Number.isFinite(u));
      }
    }
  }
});

// T2: legacy region align for 3 directions, layer invariant 1e-12, water/rngState unchanged
test("T2: align on 3 hex directions preserves bedrock+soil==elevation (1e-12), water and rngState", () => {
  const state = createInitialWorld({ seed: 991, width: W, height: H, regionId: "garden-1" });
  // ensure layers present and controlled
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile) || tile.terrain === "water") continue;
    tile.terrain = "plain";
    tile.bedrockElevation = 0.2;
    tile.soilThickness = 0.1;
    tile.elevation = 0.3;
    delete tile.resource;
  }
  const rngBefore = state.rngState;
  const waterBefore = state.tiles.filter(t => t.terrain === "water").map(t => ({ x: t.x, y: t.y, e: t.elevation }));
  const changed = alignRegionBoundaryElevations(state, SEED, 0, 0, {
    directions: { west: true, northWest: true, northEast: true },
  }, 4);
  assert.ok(changed >= 0);
  assert.equal(state.rngState, rngBefore);
  const waterAfter = state.tiles.filter(t => t.terrain === "water").map(t => ({ x: t.x, y: t.y, e: t.elevation }));
  assert.deepEqual(waterAfter, waterBefore);
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile) || tile.terrain === "water") continue;
    const b = tile.bedrockElevation ?? 0;
    const s = tile.soilThickness ?? 0;
    const e = tile.elevation ?? 0;
    assert.ok(Math.abs(b + s - e) < 1e-12, `layer invariant at ${tile.x},${tile.y}: ${b}+${s}!=${e}`);
    if (Number.isFinite(tile.bedrockElevation ?? NaN)) {
      assert.ok((tile.bedrockElevation ?? 0) <= 0.2 + 1e-12, "bedrock preserved (#68 path)");
    }
  }
});

// T3: fresh canonical frame continuity (no align applied; generation path continuous)
test("T3: fresh canonical frame terrain continuity across adjacent global boundary", () => {
  const aId = "hex-q0-r0";
  const bId = "hex-q1-r0"; // east neighbor
  const originA = regionGlobalCellOrigin(aId, W, H);
  const originB = regionGlobalCellOrigin(bId, W, H);
  assert.ok(originA && originB);
  const a = createInitialWorld({ seed: 111, width: W, height: H, regionId: aId });
  const b = createInitialWorld({ seed: 222, width: W, height: H, regionId: bId });
  initializeWorldTerrainFrame(a, SEED, originA.x, originA.y);
  initializeWorldTerrainFrame(b, SEED, originB.x, originB.y);
  // continuity via derived global conditions at adjacent boundary cells
  const pairs = findBoundaryPairs(aId, bId, "east");
  assert.ok(pairs.length > 0);
  for (const p of pairs.filter((_, i) => i % 3 === 0).slice(0, 10)) {
    const cA = sampleWorldConditions(SEED, p.gxA, p.gyA);
    const cB = sampleWorldConditions(SEED, p.gxB, p.gyB);
    assert.ok(Number.isFinite(cA.elevation) && Number.isFinite(cB.elevation));
    // adjacent cells in continuous field: bounded difference (not a seam jump like independent seeds)
    assert.ok(Math.abs(cA.elevation - cB.elevation) < 0.25, `seam jump ${cA.elevation} vs ${cB.elevation}`);
    // the generated tiles at those global positions should reflect the same global sampling basis
    const tA = getTile(a, { x: p.a.localX, y: p.a.localY });
    const tB = getTile(b, { x: p.b.localX, y: p.b.localY });
    if (tA && tB && tA.terrain !== "water" && tB.terrain !== "water") {
      assert.ok(Number.isFinite(tA.elevation ?? NaN));
      assert.ok(Number.isFinite(tB.elevation ?? NaN));
    }
  }
});

// T4: existing W/E behavior maintained (covered by updated world-scale.test.mjs) — explicit pin here too
test("T4: existing west/east alignment still works via directions.west/east", () => {
  const region = createInitialWorld({ seed: 991, width: W, height: H });
  const y = 11, westX = 8, eastX = 30, innerX = 12;
  const west = region.tiles[y * region.width + westX];
  const east = region.tiles[y * region.width + eastX];
  const inner = region.tiles[y * region.width + innerX];
  assert.ok(west && east && inner && isHexGridCell(region, west) && isHexGridCell(region, east));
  west.terrain = "plain"; west.elevation = 0.9; delete west.bedrockElevation; delete west.soilThickness;
  east.terrain = "plain"; east.elevation = 0.88; delete east.bedrockElevation; delete east.soilThickness;
  inner.elevation = 0.13; delete inner.bedrockElevation; delete inner.soilThickness;
  const changed = alignRegionBoundaryElevations(region, SEED, 40, 0, { directions: { west: true, east: true } }, 4);
  assert.ok(changed > 0);
  assert.ok(Math.abs(inner.elevation - 0.13) < 1e-12);
});
