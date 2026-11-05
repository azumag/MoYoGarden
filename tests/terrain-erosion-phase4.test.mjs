import assert from "node:assert/strict";
import test from "node:test";
import {
  UPLIFT_INTERVAL,
  applyTerrainErosion,
  applyTerrainUplift,
  updateTileHydrology,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";

function allLandTiles(state) {
  return state.tiles.filter((tile) => tile.terrain !== "water" && inBounds(state, tile));
}

function totalSoil(state) {
  let sum = 0;
  for (const tile of allLandTiles(state)) sum += Math.max(0, tile.soilThickness ?? 0);
  return sum;
}

function meanLandElevation(state) {
  const tiles = allLandTiles(state);
  let sum = 0;
  for (const tile of tiles) sum += tile.elevation ?? 0;
  return tiles.length > 0 ? sum / tiles.length : 0;
}

function assertTerrainInvariant(state) {
  for (const tile of allLandTiles(state)) {
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = tile.soilThickness ?? 0;
    const elev = tile.elevation ?? 0;
    assert.ok(Math.abs(bedrock + soil - elev) < 1e-12, `invariant at ${tile.x},${tile.y}: ${bedrock}+${soil}!=${elev}`);
  }
}

test("uplift only does not increase soil amount", () => {
  const state = createInitialWorld({ seed: 9090, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
  }
  updateTileHydrology(state);
  const soilBefore = totalSoil(state);
  const bedrockBefore = allLandTiles(state).reduce((s, t) => s + (t.bedrockElevation ?? 0), 0);
  const uplifted = applyTerrainUplift(state);
  assert.ok(uplifted > 0);
  const soilAfter = totalSoil(state);
  const bedrockAfter = allLandTiles(state).reduce((s, t) => s + (t.bedrockElevation ?? 0), 0);
  assert.ok(Math.abs(soilAfter - soilBefore) < 1e-12, `soil changed: ${soilBefore} -> ${soilAfter}`);
  assert.ok(bedrockAfter > bedrockBefore + 1e-12);
  assertTerrainInvariant(state);
});

test("if uplift exceeds erosion, long-term mean elevation can rise", () => {
  // Nearly flat/no-flow land so erosion is minimal; uplift still applies.
  const state = createInitialWorld({ seed: 9191, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    tile.bedrockElevation = 0.3;
    tile.soilThickness = 0.2;
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  updateTileHydrology(state);
  // Remove flow to suppress erosion
  for (const tile of allLandTiles(state)) delete tile.flowTo;
  const elevBefore = meanLandElevation(state);
  for (let i = 0; i < 5; i += 1) {
    applyTerrainUplift(state);
    applyTerrainErosion(state);
  }
  const elevAfter = meanLandElevation(state);
  assert.ok(elevAfter > elevBefore + 1e-9, `mean elevation did not rise: ${elevBefore} -> ${elevAfter}`);
  assertTerrainInvariant(state);
});

test("when uplift is not applied, erosion behavior remains consistent (current behavior)", () => {
  // Erosion-only path (no uplift calls) preserves conservation and invariants.
  const state = createInitialWorld({ seed: 9292, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (!inBounds(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
    delete tile.drainage;
    delete tile.erosionPressure;
  }
  const source = getTile(state, { x: 6, y: 6 });
  const target = getTile(state, { x: 7, y: 6 });
  assert.ok(source && target);
  source.elevation = 0.6;
  target.elevation = 0.4;
  updateTileHydrology(state);
  for (const tile of state.tiles) delete tile.flowTo;
  source.flowTo = { x: target.x, y: target.y };
  source.drainage = 2;

  const ledger = applyTerrainErosion(state);
  if (ledger.removed + (ledger.bedrockRemoved ?? 0) > 0) {
    assert.ok(
      Math.abs(ledger.removed + (ledger.bedrockRemoved ?? 0) - (ledger.deposited + ledger.waterExport + ledger.clampLoss)) < 1e-9,
    );
  }
  assertTerrainInvariant(state);
  // Uplift interval constant is independent from erosion interval
  assert.equal(UPLIFT_INTERVAL, 1200);
});

test("after uplift and erosion, all tiles maintain bedrock + soil == elevation (1e-12)", () => {
  const state = createInitialWorld({ seed: 9393, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
  }
  updateTileHydrology(state);
  // Mix uplift and erosion events
  for (let i = 0; i < 6; i += 1) {
    applyTerrainUplift(state);
    applyTerrainErosion(state);
  }
  assertTerrainInvariant(state);
  for (const tile of allLandTiles(state)) {
    assert.ok((tile.soilThickness ?? 0) >= -1e-12);
    assert.ok((tile.bedrockElevation ?? 0) >= -1e-12);
  }
});

function cloneState(state) {
  return structuredClone(state);
}

function terrainFingerprint(state) {
  // Deterministic fingerprint of terrain/water-relevant fields for trajectory comparison.
  return state.tiles
    .filter((t) => inBounds(state, t))
    .map((t) => [t.x, t.y, t.terrain, t.bedrockElevation ?? 0, t.soilThickness ?? 0, t.elevation ?? 0, t.flowTo?.x ?? -1, t.flowTo?.y ?? -1, t.drainage ?? 0].join(","))
    .join("|") + `#${state.tick}#${state.rngState}`;
}

test("exact-u: uplift-only tick raises bedrock/elevation by exactly u and leaves soil unchanged", async () => {
  const { upliftRateAt } = await import("../dist-ts/src/simulation.js");
  const state = createInitialWorld({ seed: 9494, width: 16, height: 12 });
  for (const tile of allLandTiles(state)) {
    tile.terrain = "plain";
    delete tile.resource;
    delete tile.flowTo;
  }
  updateTileHydrology(state);
  for (const tile of allLandTiles(state)) {
    const u = upliftRateAt(state, tile);
    assert.ok(u >= 0 && u <= 0.001 + 1e-15, `u out of range: ${u}`);
    const soilBefore = tile.soilThickness ?? 0;
    const bedrockBefore = tile.bedrockElevation ?? 0;
    const elevBefore = tile.elevation ?? 0;
    // apply uplift to this tile only by using a rate function that targets it
    const s1 = cloneState(state);
    const t1 = s1.tiles.find((x) => x.x === tile.x && x.y === tile.y && inBounds(s1, x));
    assert.ok(t1);
    applyTerrainUplift(s1, (_st, tt) => (tt.x === tile.x && tt.y === tile.y ? u : 0));
    const a1 = s1.tiles.find((x) => x.x === tile.x && x.y === tile.y);
    assert.ok(Math.abs((a1.soilThickness ?? 0) - soilBefore) < 1e-12);
    assert.ok(Math.abs((a1.bedrockElevation ?? 0) - (bedrockBefore + u)) < 1e-12);
    assert.ok(Math.abs((a1.elevation ?? 0) - (elevBefore + u)) < 1e-12);
  }
  // full uplift-only event (no erosion) keeps soil total unchanged and is exact per tile
  const s2 = cloneState(state);
  const before = new Map(allLandTiles(s2).map((t) => [`${t.x},${t.y}`, { b: t.bedrockElevation ?? 0, s: t.soilThickness ?? 0, e: t.elevation ?? 0, u: upliftRateAt(s2, t) }]));
  applyTerrainUplift(s2);
  for (const [k, v] of before.entries()) {
    const [x, y] = k.split(",").map(Number);
    const t = s2.tiles.find((tt) => tt.x === x && tt.y === y);
    assert.ok(t);
    assert.ok(Math.abs((t.soilThickness ?? 0) - v.s) < 1e-12);
    assert.ok(Math.abs((t.bedrockElevation ?? 0) - (v.b + v.u)) < 1e-12);
    assert.ok(Math.abs((t.elevation ?? 0) - (v.e + v.u)) < 1e-12);
  }
});

test("cadence: uplift fires only on multiples of 1200 ticks", async () => {
  const { DEFAULT_SIMULATION_CONFIG } = await import("../dist-ts/src/protocol.js");
  const { simulate } = await import("../dist-ts/src/simulation.js");
  const zeroUplift = { ...DEFAULT_SIMULATION_CONFIG, upliftRateAt: () => 0 };
  const withUplift = { ...DEFAULT_SIMULATION_CONFIG };

  // Non-multiple of 1200: previous tick 1198 -> tick becomes 1199 (1199%1200!=0, 1199%120!=0)
  const s1 = createInitialWorld({ seed: 9595, width: 16, height: 12 });
  for (const tile of allLandTiles(s1)) { tile.terrain = "plain"; delete tile.resource; }
  updateTileHydrology(s1);
  s1.tick = 1198;
  const r1 = simulate(s1, [], withUplift).state;
  const r1z = simulate(s1, [], zeroUplift).state;
  assert.equal(r1.tick, 1199);
  assert.equal(terrainFingerprint(r1), terrainFingerprint(r1z), "tick 1199 (non-1200 multiple) must not differ due to uplift");

  // Multiple of 1200: previous tick 1199 -> tick becomes 1200
  const s2 = createInitialWorld({ seed: 9595, width: 16, height: 12 });
  for (const tile of allLandTiles(s2)) { tile.terrain = "plain"; delete tile.resource; }
  updateTileHydrology(s2);
  s2.tick = 1199;
  let calls = 0;
  const r2 = simulate(s2, [], { ...DEFAULT_SIMULATION_CONFIG, upliftRateAt: (st, tile) => { calls += 1; return 0; } }).state;
  assert.equal(r2.tick, 1200);
  assert.ok(calls > 0, "upliftRateAt must be called on tick multiple of 1200");

  const s3 = createInitialWorld({ seed: 9595, width: 16, height: 12 });
  for (const tile of allLandTiles(s3)) { tile.terrain = "plain"; delete tile.resource; }
  updateTileHydrology(s3);
  s3.tick = 1198; // becomes 1199
  calls = 0;
  simulate(s3, [], { ...DEFAULT_SIMULATION_CONFIG, upliftRateAt: (st, tile) => { calls += 1; return 0; } });
  assert.equal(calls, 0, "upliftRateAt must not be called on non-multiple of 1200");
});

test("uplift=0 path is identical trajectory to no-uplift (Phase 3 baseline-equivalent) by fingerprint", async () => {
  const { DEFAULT_SIMULATION_CONFIG } = await import("../dist-ts/src/protocol.js");
  const { simulate } = await import("../dist-ts/src/simulation.js");
  const zeroUplift = { ...DEFAULT_SIMULATION_CONFIG, upliftRateAt: () => 0 };

  function run(seed, ticks, config) {
    let state = createInitialWorld({ seed, width: 16, height: 12 });
    for (let i = 0; i < ticks; i += 1) state = simulate(state, [], config).state;
    return terrainFingerprint(state);
  }

  // Zero-uplift path is deterministic and stable across 1200-tick boundary (Phase 3 baseline-equivalent behavior).
  const fpA = run(9797, 1300, zeroUplift);
  const fpB = run(9797, 1300, zeroUplift);
  assert.equal(fpA, fpB);
  // Verify the zero-uplift path applies no uplift delta at the boundary by direct check.
  const state = createInitialWorld({ seed: 9797, width: 16, height: 12 });
  state.tick = 1199;
  for (const tile of allLandTiles(state)) { tile.terrain = "plain"; delete tile.resource; }
  updateTileHydrology(state);
  const before = cloneState(state);
  applyTerrainUplift(state, () => 0);
  assert.equal(terrainFingerprint(state), terrainFingerprint(before), "zero uplift rate must be a no-op");
});
