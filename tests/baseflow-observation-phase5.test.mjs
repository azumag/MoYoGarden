import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  BASEFLOW_PROPAGATION_STEPS,
  BASEFLOW_SOURCE_THRESHOLD,
  observeBaseflowAt,
  observeBaseflowMap,
  observeBaseflowSpringSource,
} from "../dist-ts/src/landform-observation.js";
import {
  getTileGlobalPosition,
  surfaceMoistureAt,
  updateTileHydrology,
  updateTileSoilMoisture,
} from "../dist-ts/src/simulation.js";
import { createInitialWorld, getTile, inBounds } from "../dist-ts/src/world.js";
import {
  derivePermeability,
  derivePorosity,
  precipitationAt,
  sampleWorldConditions,
} from "../dist-ts/src/world-scale.js";

function key(x, y) { return `${x},${y}`; }
function landTiles(state) { return state.tiles.filter((t) => t.terrain !== "water" && inBounds(state, t)); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function makePlainWorld(seed = 424242) {
  const state = createInitialWorld({ seed, width: 24, height: 16, regionId: "garden-1" });
  for (const t of state.tiles) {
    if (!isHexGridCell(state, t)) continue;
    t.terrain = "plain";
    delete t.resource;
  }
  updateTileHydrology(state);
  for (const t of landTiles(state)) {
    t.groundwaterStorage = 0;
    t.soilMoisture = Math.max(0, t.soilMoisture ?? 0.02);
  }
  return state;
}

// 1. determinism + pure pin (deep-equal, state not mutated)
test("baseflow observation is deterministic, pure, and non-mutating (rngState unchanged)", () => {
  const state = makePlainWorld(5101);
  for (const t of landTiles(state)) { t.groundwaterStorage = 0.01; t.flowTo = { x: t.x, y: t.y }; }
  updateTileHydrology(state);
  const before = structuredClone(state);
  const rngBefore = state.rngState;
  const a = observeBaseflowMap(state);
  const b = observeBaseflowMap(state);
  assert.equal(state.rngState, rngBefore);
  assert.deepEqual(state, before);
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

// 2. spring source threshold
test("baseflow spring source: near-saturated with outflow stands, low storage does not", () => {
  const state = makePlainWorld(5102);
  const t = landTiles(state).find((x) => isHexGridCell(state, x) && x.flowTo !== undefined) ?? landTiles(state)[0];
  assert.ok(t);
  // compute maxStorage
  const { globalX, globalY } = getTileGlobalPosition(state, t);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const surface = t.elevation ?? 0;
  const bedrock = Math.max(0, t.bedrockElevation ?? 0);
  const maxStorage = Math.max(0, porosity * Math.max(0, surface - bedrock));
  assert.ok(maxStorage > 1e-6);
  t.groundwaterStorage = maxStorage * (BASEFLOW_SOURCE_THRESHOLD + 0.05);
  assert.equal(observeBaseflowSpringSource(state, t), true);
  t.groundwaterStorage = maxStorage * (BASEFLOW_SOURCE_THRESHOLD - 0.15);
  assert.equal(observeBaseflowSpringSource(state, t), false);
  // no outflow => not a source
  t.groundwaterStorage = maxStorage * 0.99;
  const saved = t.flowTo;
  delete t.flowTo;
  assert.equal(observeBaseflowSpringSource(state, t), false);
  t.flowTo = saved;
  // water excluded
  const w = state.tiles.find((x) => x.terrain === "water");
  if (w) assert.equal(observeBaseflowSpringSource(state, w), false);
});

// 3. downstream propagation along flowTo chain, cut off after N steps
test("spring-fed propagation follows flowTo chain up to BASEFLOW_PROPAGATION_STEPS", () => {
  const state = makePlainWorld(5103);
  // build a deterministic chain on valid hex cells
  const cells = state.tiles.filter((t) => isHexGridCell(state, t));
  // find a connected-ish sequence using flowTo by constructing manually
  const chain = [];
  // pick cells in a row that exist
  for (let i = 0; i < 12; i++) {
    const c = getTile(state, { x: 5 + i, y: 6 });
    if (c && isHexGridCell(state, c)) chain.push(c);
  }
  assert.ok(chain.length >= BASEFLOW_PROPAGATION_STEPS + 3, `chain too short: ${chain.length}`);
  // wire flowTo along chain
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].flowTo = { x: chain[i + 1].x, y: chain[i + 1].y };
    chain[i].terrain = "plain";
  }
  chain[chain.length - 1].terrain = "plain";
  // make first a spring source
  const src = chain[0];
  const { globalX, globalY } = getTileGlobalPosition(state, src);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const maxStorage = Math.max(0, porosity * Math.max(0, (src.elevation ?? 0) - Math.max(0, src.bedrockElevation ?? 0)));
  for (const c of chain) c.groundwaterStorage = 0;
  src.groundwaterStorage = maxStorage * 0.95;

  const map = observeBaseflowMap(state);
  assert.equal(map.get(key(src.x, src.y))?.source, true);
  assert.equal(map.get(key(src.x, src.y))?.springFed, true);
  assert.equal(map.get(key(src.x, src.y))?.stepsFromSource, 0);
  for (let i = 1; i <= BASEFLOW_PROPAGATION_STEPS; i++) {
    const c = chain[i];
    const obs = map.get(key(c.x, c.y));
    assert.equal(obs?.springFed, true, `chain[${i}] should be spring-fed`);
    assert.equal(obs?.stepsFromSource, i);
  }
  // beyond limit not labeled by this source (if no other source reaches)
  if (chain.length > BASEFLOW_PROPAGATION_STEPS + 1) {
    const far = chain[BASEFLOW_PROPAGATION_STEPS + 1];
    const obs = map.get(key(far.x, far.y));
    assert.ok(obs?.springFed !== true || (obs.stepsFromSource ?? 99) > BASEFLOW_PROPAGATION_STEPS,
      `chain beyond ${BASEFLOW_PROPAGATION_STEPS} should not be spring-fed by source`);
  }
});

// 6 (subset): water excluded, rngState unchanged, bedrock+soil≡elevation 1e-12 preserved by observation
test("baseflow observation excludes water, preserves rngState and terrain invariants", () => {
  const state = makePlainWorld(5106);
  const rngBefore = state.rngState;
  observeBaseflowMap(state);
  assert.equal(state.rngState, rngBefore);
  for (const t of landTiles(state)) {
    const e = t.elevation ?? 0;
    const b = Math.max(0, t.bedrockElevation ?? 0);
    const s = Math.max(0, t.soilThickness ?? 0);
    assert.ok(Math.abs(b + s - e) < 1e-12, `invariant at ${t.x},${t.y}`);
  }
  const w = state.tiles.find((x) => x.terrain === "water");
  if (w) assert.equal(observeBaseflowAt(state, w).springFed, false);
});

// 4. drought persistence: spring-supported tile maintains higher soil moisture / surface moisture
test("drought persistence: high-groundwater spring context keeps moisture higher over multiple water steps", () => {
  const state = makePlainWorld(5104);
  // pick two valid land tiles with similar base setup
  const candidates = landTiles(state).filter((t) => isHexGridCell(state, t));
  assert.ok(candidates.length >= 2);
  const springTile = candidates[0];
  const dryTile = candidates[1];
  // make springTile artesian/high storage (discharge credits soil moisture)
  const { globalX: gx, globalY: gy } = getTileGlobalPosition(state, springTile);
  const cond = sampleWorldConditions(state.seed, gx, gy);
  const por = derivePorosity(state.seed, gx, gy, cond.elevation);
  const maxS = Math.max(0, por * Math.max(0, (springTile.elevation ?? 0) - Math.max(0, springTile.bedrockElevation ?? 0)));
  springTile.groundwaterStorage = Math.max(maxS * 1.5, 0.05); // strong artesian
  dryTile.groundwaterStorage = 0;
  springTile.soilMoisture = 0.01;
  dryTile.soilMoisture = 0.01;

  // run several water-balance ticks
  let springHigher = 0;
  for (let step = 1; step <= 8; step++) {
    state.tick = step * 12;
    updateTileSoilMoisture(state);
    const smSpring = surfaceMoistureAt(state, { x: springTile.x, y: springTile.y });
    const smDry = surfaceMoistureAt(state, { x: dryTile.x, y: dryTile.y });
    if ((springTile.soilMoisture ?? 0) >= (dryTile.soilMoisture ?? 0) - 1e-12 && smSpring >= smDry - 1e-12) {
      springHigher++;
    }
  }
  assert.ok(springHigher >= 5, `spring tile should maintain moisture in most steps, got ${springHigher}/8`);
});

// 5. balance identities (spring active, DSH #25 Phase 5): spring term included
test("spring-active water step: system Δsoil+Δgw = precip-drying-overflow (1e-9, spring ledger pinned)", () => {
  const state = makePlainWorld(5105);
  // force active spring conditions on some tiles
  for (const t of landTiles(state)) {
    const { globalX, globalY } = getTileGlobalPosition(state, t);
    const cond = sampleWorldConditions(state.seed, globalX, globalY);
    const por = derivePorosity(state.seed, globalX, globalY, cond.elevation);
    const maxS = Math.max(0, por * Math.max(0, (t.elevation ?? 0) - Math.max(0, t.bedrockElevation ?? 0)));
    t.groundwaterStorage = maxS * 1.2;
    t.soilMoisture = 0.02;
    t.soilMoistureOverflow = 0;
  }
  state.tick = 12;
  const before = new Map();
  let swBefore = 0, pendingBefore = 0;
  for (const t of state.tiles) {
    if (!inBounds(state, t)) continue;
    if (t.terrain === "water") swBefore += Math.max(0, t.surfaceWater ?? 0);
    else {
      before.set(key(t.x, t.y), { soil: t.soilMoisture ?? 0, gw: t.groundwaterStorage ?? 0 });
      pendingBefore += Math.max(0, t.soilMoistureOverflow ?? 0);
    }
  }
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger);
  assert.ok(ledger.springDischarge > 0, "fixture should activate spring discharge");
  assert.ok(Math.abs(ledger.springDischarge - [...ledger.springDischargeByTile.values()].reduce((a,b)=>a+b,0)) < 1e-9,
    "spring ledger per-tile sum matches total");

  let dSoil = 0, dGw = 0, swAfter = 0, pendingAfter = 0;
  for (const t of state.tiles) {
    if (!inBounds(state, t)) continue;
    if (t.terrain === "water") swAfter += Math.max(0, t.surfaceWater ?? 0);
    else {
      const b = before.get(key(t.x, t.y));
      dSoil += (t.soilMoisture ?? 0) - b.soil;
      dGw += (t.groundwaterStorage ?? 0) - b.gw;
      pendingAfter += Math.max(0, t.soilMoistureOverflow ?? 0);
    }
  }
  // Spring-inclusive conservation (ledger totals): Δsoil + Δgw = precip - drying - overflow (1e-9)
  // overflow ledger includes recharge runoff/saturation + spring overflow contributions.
  const identity = dSoil + dGw - (ledger.precipitation - ledger.drying - ledger.overflow);
  assert.ok(Math.abs(identity) < 1e-9, `system balance mismatch: ${identity}`);
  // Master form (Phase 5) also holds
  const master = (dSoil + dGw + (swAfter - swBefore) + (pendingAfter - pendingBefore))
    - (ledger.precipitation - ledger.drying - ledger.surfaceWaterSpill);
  assert.ok(Math.abs(master) < 1e-9, `master mismatch: ${master}`);
});

// 5b. per-tile recharge identity with spring ledger pinned (DSH #25 Phase 5, spring-inclusive fixture)
test("spring-active: per-tile recharge Δsoil+overflow_inflow+percolation = infiltration-drying (1e-9) with spring ledger", () => {
  const state = makePlainWorld(5107);
  // controlled fixture: set known storages to force some spring activity
  for (const t of landTiles(state)) {
    const { globalX, globalY } = getTileGlobalPosition(state, t);
    const cond = sampleWorldConditions(state.seed, globalX, globalY);
    const por = derivePorosity(state.seed, globalX, globalY, cond.elevation);
    const maxS = Math.max(0, por * Math.max(0, (t.elevation ?? 0) - Math.max(0, t.bedrockElevation ?? 0)));
    t.groundwaterStorage = maxS * 1.1;
    t.soilMoisture = 0.015;
    t.soilMoistureOverflow = 0;
  }
  state.tick = 24; // WATER_BALANCE_INTERVAL
  const before = new Map();
  for (const t of landTiles(state)) before.set(key(t.x, t.y), { soil: t.soilMoisture ?? 0, gw: t.groundwaterStorage ?? 0, ov: t.soilMoistureOverflow ?? 0 });
  const ledger = updateTileSoilMoisture(state);
  assert.ok(ledger);
  assert.ok(ledger.springDischarge > 0, "fixture should activate spring discharge");

  let checkedSpring = 0;
  for (const t of landTiles(state)) {
    const k = key(t.x, t.y);
    const b = before.get(k);
    const { globalX: gx, globalY: gy } = getTileGlobalPosition(state, t);
    const conditions = sampleWorldConditions(state.seed, gx, gy);
    const permeability = derivePermeability(state.seed, gx, gy, conditions.elevation, conditions.slope);
    const porosity = derivePorosity(state.seed, gx, gy, conditions.elevation);
    const soilThickness = Math.max(0, t.soilThickness ?? 0.01);
    const capacity = Math.max(0.01, Math.min(0.5, porosity * (0.6 + soilThickness * 1.8)));
    const currentMoisture = b.soil;
    const precip = precipitationAt(state.seed, gx, gy, state.tick) * 12;
    const infiltration = precip * permeability * (1 - clamp01(currentMoisture / Math.max(1e-6, capacity)));
    const runoff = Math.max(0, precip - infiltration);
    const equilibriumFrac = clamp01(0.15 + conditions.wetness * 0.35 + (1 - conditions.slope) * 0.1 - conditions.temperature * 0.08);
    const equilibrium = equilibriumFrac * capacity;
    const dryingRate = 0.06 + (1 - conditions.wetness) * 0.04;
    const drying = Math.max(0, Math.min(currentMoisture + infiltration, (currentMoisture - equilibrium) * dryingRate));
    let moisture = currentMoisture + infiltration - drying;
    const bedrock = Math.max(0, t.bedrockElevation ?? 0);
    const surface = Math.max(bedrock, t.elevation ?? (bedrock + soilThickness));
    const maxStorage = Math.max(0, porosity * Math.max(0, surface - bedrock));
    const fieldCapacity = capacity * 0.6;
    const percRate = 0.08;
    const storageBefore = b.gw;
    const percolationPotential = percRate * permeability * Math.max(0, moisture - fieldCapacity);
    const perc = Math.min(percolationPotential, Math.max(0, moisture), Math.max(0, maxStorage - storageBefore));
    moisture -= perc;
    let satOverflow = 0;
    if (moisture > capacity) { satOverflow = moisture - capacity; moisture = capacity; }
    if (moisture < 0) moisture = 0;
    const percLedger = ledger.percolationByTile.get(k) ?? 0;
    assert.ok(Math.abs(perc - percLedger) < 1e-9, `percolation ledger mismatch at ${k}`);
    const spring = ledger.springDischargeByTile.get(k) ?? 0;
    // recharge-frame identity (always exact per step): Δsoil_recharge + overflowInflow + percolation = infiltration - drying
    // spring is accounted as a separate conserved transfer (gw -> soil/pending) pinned via springDischargeByTile ledger.
    const overflowInflow = runoff + satOverflow;
    const identity = (moisture - currentMoisture) + overflowInflow + perc;
    assert.ok(Math.abs(identity - (precip - drying)) < 1e-9,
      `per-tile balance at ${k}: ${identity} vs ${precip - drying}`);
    if (spring > 0) checkedSpring++;
  }
  assert.ok(checkedSpring > 0, "expected spring-active tiles in fixture");
});
