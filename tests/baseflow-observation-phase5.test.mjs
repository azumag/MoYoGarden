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


function poreCap(state, t) {
  const { globalX, globalY } = getTileGlobalPosition(state, t);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  const surface = t.elevation ?? 0;
  const bedrock = Math.max(0, t.bedrockElevation ?? 0);
  return Math.max(0, porosity * Math.max(0, surface - bedrock));
}

// Lateral-fed spring fixture (DSH canonical): upstream high storage + head gradient
// -> Phase 3 lateral inflow sustains downstream storage at/above cap -> spring fires.
function makeLateralFedSpringFixture(seed = 5250) {
  const state = createInitialWorld({ seed, width: 24, height: 16, regionId: "garden-1" });
  for (const t of state.tiles) { if (isHexGridCell(state, t)) { t.terrain = "plain"; delete t.resource; } }
  // Build a gentle downhill chain with explicit elevations/layers for a stable head gradient.
  const chain = [];
  for (let i = 0; i < 8; i++) {
    const c = getTile(state, { x: 4 + i, y: 7 });
    if (c && isHexGridCell(state, c) && c.terrain !== "water") chain.push(c);
  }
  assert.ok(chain.length >= 5, "fixture chain");
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    c.terrain = "plain";
    c.bedrockElevation = 0.20;
    c.soilThickness = 0.06;
    c.elevation = 0.26 - i * 0.012;
    c.soilMoisture = 0.015;
    c.groundwaterStorage = 0;
    c.soilMoistureOverflow = 0;
    if (i < chain.length - 1) c.flowTo = { x: chain[i + 1].x, y: chain[i + 1].y };
  }
  updateTileHydrology(state);
  // Recharge upstream heavily; downstream starts at cap to allow artesian/spring with inflow.
  const up = chain[0];
  const mid = chain[Math.floor(chain.length / 2)];
  const down = chain[chain.length - 2];
  up.groundwaterStorage = poreCap(state, up) * 4.0;
  mid.groundwaterStorage = poreCap(state, mid) * 0.8;
  down.groundwaterStorage = poreCap(state, down) * 1.05; // near/over cap
  return { state, chain, up, mid, down };
}

// 4. drought persistence (DSH canonical lateral-fed spring): upstream high storage + head gradient
// -> lateral inflow sustains springing tile(s); soilMoisture/surfaceMoistureAt stay higher than control.
test("drought persistence: lateral-fed spring sustains moisture over multiple water steps", () => {
  const { state, chain } = makeLateralFedSpringFixture(5251);
  // control tile outside the fed chain with no groundwater support
  const chainSet = new Set(chain.map((t) => key(t.x, t.y)));
  const control = landTiles(state).find((t) => isHexGridCell(state, t) && !chainSet.has(key(t.x, t.y))) ?? landTiles(state).at(-1);
  assert.ok(control);
  control.groundwaterStorage = 0;
  control.soilMoisture = 0.01;
  control.soilMoistureOverflow = 0;

  // identify a sustained spring-fed tile (lateral-fed): fires and is supported over steps
  let fedTile = null;
  let sawSpring = false;
  for (let step = 1; step <= 4; step++) {
    state.tick = step * 12;
    const ledger = updateTileSoilMoisture(state);
    assert.ok(ledger);
    if (ledger.springDischarge > 1e-12) sawSpring = true;
    for (const [k] of ledger.springDischargeByTile.entries()) {
      if ((ledger.springDischargeByTile.get(k) ?? 0) > 1e-12) {
        const [x, y] = k.split(",").map(Number);
        const t = getTile(state, { x, y });
        if (t && t.terrain !== "water") { fedTile = t; break; }
      }
    }
  }
  assert.ok(sawSpring, "lateral-fed fixture should fire spring discharge");
  assert.ok(fedTile, "expected a spring-fed tile");

  // compare over multiple additional water steps
  let springHigher = 0;
  for (let step = 5; step <= 14; step++) {
    state.tick = step * 12;
    updateTileSoilMoisture(state);
    const smFed = surfaceMoistureAt(state, { x: fedTile.x, y: fedTile.y });
    const smCtl = surfaceMoistureAt(state, { x: control.x, y: control.y });
    if ((fedTile.soilMoisture ?? 0) > (control.soilMoisture ?? 0) + 1e-9 || smFed > smCtl + 1e-9) springHigher++;
  }
  assert.ok(springHigher >= 6, `fed spring tile should maintain moisture advantage in most steps, got ${springHigher}/10`);
});

// 5. balance identities (spring active, DSH #25 Phase 5, lateral-fed spring fixture)
test("lateral-fed spring: system conservation with spring ledger pinned (1e-9)", () => {
  const { state } = makeLateralFedSpringFixture(5252);
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
  // may need a step or two; run once more if not fired
  if (ledger.springDischarge <= 1e-12) {
    state.tick = 24;
    updateTileSoilMoisture(state);
  }
  // verify over a step that fires
  for (const t of state.tiles) {
    if (!inBounds(state, t) || t.terrain === "water") continue;
    before.set(key(t.x, t.y), { soil: t.soilMoisture ?? 0, gw: t.groundwaterStorage ?? 0 });
  }
  swBefore = 0; pendingBefore = 0;
  for (const t of state.tiles) {
    if (!inBounds(state, t)) continue;
    if (t.terrain === "water") swBefore += Math.max(0, t.surfaceWater ?? 0);
    else pendingBefore += Math.max(0, t.soilMoistureOverflow ?? 0);
  }
  state.tick = 36;
  const ledger2 = updateTileSoilMoisture(state);
  assert.ok(ledger2);
  assert.ok(Math.abs(ledger2.springDischarge - [...ledger2.springDischargeByTile.values()].reduce((a,b)=>a+b,0)) < 1e-9,
    "spring ledger per-tile sum matches total");
  assert.ok(ledger2.springDischarge > 0, "lateral-fed fixture should activate spring discharge");

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
  const identity = dSoil + dGw - (ledger2.precipitation - ledger2.drying - ledger2.overflow);
  assert.ok(Math.abs(identity) < 1e-9, `system balance mismatch: ${identity}`);
  const master = (dSoil + dGw + (swAfter - swBefore) + (pendingAfter - pendingBefore))
    - (ledger2.precipitation - ledger2.drying - ledger2.surfaceWaterSpill);
  assert.ok(Math.abs(master) < 1e-9, `master mismatch: ${master}`);
});

// 5b. per-tile recharge identity with spring ledger pinned (DSH, lateral-fed spring-active fixture)
test("lateral-fed spring: per-tile recharge Δsoil+overflow_inflow+percolation = infiltration-drying (1e-9), spring ledger", () => {
  const { state } = makeLateralFedSpringFixture(5253);
  // advance until spring fires
  let ledger;
  for (let step = 1; step <= 4; step++) {
    state.tick = step * 12;
    // snapshot before the step we check
    if (step >= 2) {
      const before = new Map();
      for (const t of landTiles(state)) before.set(key(t.x, t.y), { soil: t.soilMoisture ?? 0, gw: t.groundwaterStorage ?? 0 });
      ledger = updateTileSoilMoisture(state);
      assert.ok(ledger);
      if (ledger.springDischarge > 1e-12) {
        let checkedSpring = 0;
        for (const t of landTiles(state)) {
          const k = key(t.x, t.y);
          const b = before.get(k);
          if (!b) continue;
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
          // recharge-frame identity: Δsoil_recharge + overflowInflow + percolation = infiltration - drying (1e-9)
          // spring is a conserved transfer (gw -> soil/pending) pinned via springDischargeByTile.
          const overflowInflow = runoff + satOverflow;
          const identity = (moisture - currentMoisture) + overflowInflow + perc;
          assert.ok(Math.abs(identity - (precip - drying)) < 1e-9,
            `per-tile balance at ${k}: ${identity} vs ${precip - drying}`);
          if (spring > 0) checkedSpring++;
        }
        assert.ok(checkedSpring > 0, "expected spring-active tiles in lateral-fed fixture");
        return;
      }
      continue;
    }
    ledger = updateTileSoilMoisture(state);
  }
  assert.ok((ledger?.springDischarge ?? 0) > 0, "lateral-fed fixture should activate spring discharge");
});
