import { HEX_GRID_STEPS } from "./hex-grid.js";
import type { Tile, WorldState } from "./protocol.js";
import { regionGlobalCellOrigin } from "./region-topology.js";
import { derivePorosity, sampleWorldConditions } from "./world-scale.js";
import { getTile, inBounds } from "./world.js";

export type LandformKind = "floodplain" | "alluvialFan" | "delta" | "riverIncision";
export type TerrainLandform = "floodplain" | "alluvial-fan" | "delta" | "incised";

export interface LandformObservation {
  kind: LandformKind;
  active: boolean;
  /** 0..1 indicator strength (derived, non-persistent). */
  strength: number;
}

export interface TileLandformObservations {
  floodplain: LandformObservation;
  alluvialFan: LandformObservation;
  delta: LandformObservation;
  riverIncision: LandformObservation;
}

const EPS = 1e-9;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function tileElevation(tile: Tile | undefined): number {
  if (tile === undefined) return 0;
  if (Number.isFinite(tile.elevation ?? Number.NaN)) return tile.elevation as number;
  return Math.max(0, (tile.bedrockElevation ?? 0) + Math.max(0, tile.soilThickness ?? 0));
}

function slopeAndDownhill(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
): { maxDownslope: number; maxUpslope: number; meanNeighborElev: number; waterNeighbor: boolean; lowerNeighborCount: number } {
  const e = tileElevation(tile);
  let maxDownslope = 0;
  let maxUpslope = 0;
  let sum = 0;
  let count = 0;
  let waterNeighbor = false;
  let lowerNeighborCount = 0;
  for (const d of HEX_GRID_STEPS) {
    const n = getTile(state, { x: tile.x + d.x, y: tile.y + d.y });
    if (n === undefined || !inBounds(state, n)) continue;
    if (n.terrain === "water") waterNeighbor = true;
    const ne = n.terrain === "water" ? 0 : tileElevation(n);
    const drop = e - ne;
    if (drop > maxDownslope) maxDownslope = drop;
    if (-drop > maxUpslope) maxUpslope = -drop;
    if (drop > EPS) lowerNeighborCount += 1;
    sum += ne;
    count += 1;
  }
  return { maxDownslope, maxUpslope, meanNeighborElev: count > 0 ? sum / count : e, waterNeighbor, lowerNeighborCount };
}

// Enter/exit threshold pairs (gap >= 0.03) for hysteresis without auxiliary state.
// Callers may pass `previouslyActive` to apply exit thresholds and avoid flapping.
export const LANDFORM_THRESHOLDS = {
  floodplain: { enter: 0.55, exit: 0.50 },
  alluvialFan: { enter: 0.56, exit: 0.52 },
  delta: { enter: 0.57, exit: 0.53 },
  riverIncision: { enter: 0.56, exit: 0.52 },
} as const;

function applyHysteresis(strength: number, kind: LandformKind, previouslyActive = false): boolean {
  const t = LANDFORM_THRESHOLDS[kind];
  return previouslyActive ? strength >= t.exit : strength >= t.enter;
}

export function observeFloodplain(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previouslyActive = false,
): LandformObservation {
  if (tile.terrain === "water") return { kind: "floodplain", active: false, strength: 0 };
  const e = tileElevation(tile);
  const slope = slopeAndDownhill(state, tile);
  const drainage = clamp01(tile.drainage ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  const lowland = clamp01(1 - Math.min(e, 1.5) / 0.55); // handles elevation > 0.99 safely
  const flat = clamp01(1 - slope.maxDownslope / 0.06);
  const wetCorridor = clamp01(drainage * 1.4);
  const nearFlow = slope.waterNeighbor || (tile.flowTo !== undefined && drainage > 0.15) ? 1 : 0;
  const soilOk = clamp01(soil / 0.03);
  const strength = clamp01(lowland * 0.28 + flat * 0.22 + wetCorridor * 0.28 + nearFlow * 0.12 + soilOk * 0.10);
  return { kind: "floodplain", active: applyHysteresis(strength, "floodplain", previouslyActive), strength };
}

export function observeAlluvialFan(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previouslyActive = false,
): LandformObservation {
  if (tile.terrain === "water") return { kind: "alluvialFan", active: false, strength: 0 };
  const slope = slopeAndDownhill(state, tile);
  const drainage = clamp01(tile.drainage ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  // proxy for upslope confinement -> downslope opening: steep above, gentler below
  const confinementBreak = clamp01((slope.maxUpslope - slope.maxDownslope) / 0.10 + 0.3);
  const depositional = clamp01(soil / 0.045);
  const channelFed = clamp01(drainage * 1.5);
  const notCliff = clamp01(1 - slope.maxDownslope / 0.20);
  const strength = clamp01(confinementBreak * 0.30 + depositional * 0.25 + channelFed * 0.25 + notCliff * 0.20);
  return { kind: "alluvialFan", active: applyHysteresis(strength, "alluvialFan", previouslyActive), strength };
}

export function observeDelta(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previouslyActive = false,
): LandformObservation {
  if (tile.terrain === "water") return { kind: "delta", active: false, strength: 0 };
  const e = tileElevation(tile);
  const slope = slopeAndDownhill(state, tile);
  const drainage = clamp01(tile.drainage ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  const nearWater = slope.waterNeighbor ? 1 : 0;
  const flowToWater = tile.flowTo ? (getTile(state, tile.flowTo)?.terrain === "water" ? 1 : 0) : 0;
  const low = clamp01(1 - Math.min(e, 1.5) / 0.45);
  const flat = clamp01(1 - slope.maxDownslope / 0.05);
  const sedimentProxy = clamp01(soil / 0.04);
  const strength = clamp01((nearWater * 0.35 + flowToWater * 0.15) + low * 0.15 + flat * 0.10 + drainage * 0.15 + sedimentProxy * 0.10);
  return { kind: "delta", active: applyHysteresis(strength, "delta", previouslyActive), strength };
}

export function observeRiverIncision(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previouslyActive = false,
): LandformObservation {
  if (tile.terrain === "water") return { kind: "riverIncision", active: false, strength: 0 };
  const slope = slopeAndDownhill(state, tile);
  const drainage = clamp01(tile.drainage ?? 0);
  const erosionPressure = clamp01(tile.erosionPressure ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  // Observation only (Phase 3 mechanism already exists): valley cut proxy from channel power + soil thinning.
  const channel = clamp01(drainage * 1.3);
  const steepEnough = clamp01(slope.maxDownslope / 0.12);
  const pressure = clamp01(erosionPressure * 1.4);
  const bedrockExposureProxy = clamp01(1 - soil / 0.05);
  const relief = clamp01((slope.meanNeighborElev - tileElevation(tile)) / 0.04 + 0.5);
  const strength = clamp01(channel * 0.28 + steepEnough * 0.18 + pressure * 0.22 + bedrockExposureProxy * 0.18 + relief * 0.14);
  return { kind: "riverIncision", active: applyHysteresis(strength, "riverIncision", previouslyActive), strength };
}

export function observeLandforms(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previous?: Partial<Record<LandformKind, boolean>>,
): TileLandformObservations {
  return {
    floodplain: observeFloodplain(state, tile, previous?.floodplain ?? false),
    alluvialFan: observeAlluvialFan(state, tile, previous?.alluvialFan ?? false),
    delta: observeDelta(state, tile, previous?.delta ?? false),
    riverIncision: observeRiverIncision(state, tile, previous?.riverIncision ?? false),
  };
}

const LANDFORM_KIND_TO_TERRAIN: Record<LandformKind, TerrainLandform> = {
  floodplain: "floodplain",
  alluvialFan: "alluvial-fan",
  delta: "delta",
  riverIncision: "incised",
};

const LANDFORM_PRIORITY: readonly LandformKind[] = ["riverIncision", "delta", "alluvialFan", "floodplain"];

export function terrainLandformAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
  previous?: TerrainLandform,
): TerrainLandform | undefined {
  if (tile.terrain === "water" || !inBounds(state, tile)) return undefined;
  const prevKind = previous === "alluvial-fan" ? "alluvialFan" : previous === "incised" ? "riverIncision" : previous;
  const obs = {
    riverIncision: observeRiverIncision(state, tile, prevKind === "riverIncision"),
    delta: observeDelta(state, tile, prevKind === "delta"),
    alluvialFan: observeAlluvialFan(state, tile, prevKind === "alluvialFan"),
    floodplain: observeFloodplain(state, tile, prevKind === "floodplain"),
  } as const;
  let best: { kind: LandformKind; strength: number } | undefined;
  for (const kind of LANDFORM_PRIORITY) {
    const o = obs[kind];
    if (!o.active) continue;
    if (best === undefined || o.strength > best.strength + EPS) best = { kind, strength: o.strength };
  }
  return best ? LANDFORM_KIND_TO_TERRAIN[best.kind] : undefined;
}


// #25 Phase 5: baseflow observation (derived, non-persistent, deterministic, read-only).
// Spring source = near-saturated aquifer with outflow; spring-fed = reachable downstream
// via flowTo chain (finite steps). No simulation/state mutation, no rng consumption.

export const BASEFLOW_SOURCE_THRESHOLD = 0.9;
export const BASEFLOW_PROPAGATION_STEPS = 6;

export interface BaseflowObservation {
  /** Near-saturated groundwater with defined outflow (baseflow source). */
  source: boolean;
  /** Tile is a spring source or reachable downstream from a spring source. */
  springFed: boolean;
  /** Shortest flowTo-step distance from a spring source (0 = source), if springFed. */
  stepsFromSource?: number;
  groundwaterFillRatio: number;
}

type BaseflowState = Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">;

function tileGlobalPos(state: BaseflowState, tile: Tile): { globalX: number; globalY: number } {
  const origin = state.regionId
    ? regionGlobalCellOrigin(state.regionId, state.width, state.height)
    : undefined;
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  return { globalX: ox + tile.x, globalY: oy + tile.y };
}

function groundwaterMaxStorage(state: BaseflowState, tile: Tile): number {
  const surface = tileElevation(tile);
  const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
  const poreDepth = Math.max(0, surface - bedrock);
  if (poreDepth <= 0) return 0;
  const { globalX, globalY } = tileGlobalPos(state, tile);
  const conditions = sampleWorldConditions(state.seed, globalX, globalY);
  const porosity = derivePorosity(state.seed, globalX, globalY, conditions.elevation);
  return Math.max(0, porosity * poreDepth);
}

export function observeBaseflowSpringSource(state: BaseflowState, tile: Tile): boolean {
  if (tile.terrain === "water" || !inBounds(state, tile)) return false;
  if (tile.flowTo === undefined) return false;
  const storage = Math.max(0, tile.groundwaterStorage ?? 0);
  const maxStorage = groundwaterMaxStorage(state, tile);
  if (maxStorage <= EPS) return false;
  return storage / maxStorage >= BASEFLOW_SOURCE_THRESHOLD;
}

/**
 * Derive baseflow observations for all land tiles: spring sources and downstream
 * spring-fed propagation along flowTo chains (up to BASEFLOW_PROPAGATION_STEPS).
 * Pure, deterministic, read-only, no rngState consumption.
 */
export function observeBaseflowMap(state: BaseflowState): Map<string, BaseflowObservation> {
  const result = new Map<string, BaseflowObservation>();
  const keyOf = (t: Tile) => `${t.x},${t.y}`;

  // Compute per-tile source/fill in deterministic tile order.
  const sources: Tile[] = [];
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) {
      result.set(keyOf(tile), { source: false, springFed: false, groundwaterFillRatio: 0 });
      continue;
    }
    const storage = Math.max(0, tile.groundwaterStorage ?? 0);
    const maxStorage = groundwaterMaxStorage(state, tile);
    const ratio = maxStorage > EPS ? storage / maxStorage : 0;
    const source = tile.flowTo !== undefined && ratio >= BASEFLOW_SOURCE_THRESHOLD;
    if (source) sources.push(tile);
    result.set(keyOf(tile), source
      ? { source: true, springFed: true, groundwaterFillRatio: ratio, stepsFromSource: 0 }
      : { source: false, springFed: false, groundwaterFillRatio: ratio });
  }

  // Propagate spring-fed label downstream from each source (deterministic source order).
  for (const src of sources) {
    let cur: Tile | undefined = src;
    for (let step = 1; step <= BASEFLOW_PROPAGATION_STEPS; step++) {
      if (cur?.flowTo === undefined) break;
      const next: Tile | undefined = getTile(state, cur.flowTo);
      if (next === undefined || !inBounds(state, next) || next.terrain === "water") break;
      const k = keyOf(next);
      const prev = result.get(k);
      if (prev && prev.springFed && (prev.stepsFromSource ?? Infinity) <= step) {
        cur = next;
        continue; // already reached at equal/shorter distance
      }
      const bestStep = Math.min(prev?.stepsFromSource ?? Infinity, step);
      result.set(k, {
        source: prev?.source ?? false,
        springFed: true,
        groundwaterFillRatio: prev?.groundwaterFillRatio ?? 0,
        stepsFromSource: bestStep,
      });
      cur = next;
    }
  }

  return result;
}

export function observeBaseflowAt(state: BaseflowState, tile: Tile): BaseflowObservation {
  if (tile.terrain === "water" || !inBounds(state, tile)) {
    return { source: false, springFed: false, groundwaterFillRatio: 0 };
  }
  const map = observeBaseflowMap(state);
  return map.get(`${tile.x},${tile.y}`) ?? { source: false, springFed: false, groundwaterFillRatio: 0 };
}
