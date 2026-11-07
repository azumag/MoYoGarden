import { HEX_GRID_DIRECTIONS, HEX_GRID_DIRECTION_STEPS, HEX_GRID_STEPS, hexGridDistance, isHexGridCell } from "./hex-grid.js";
import { regionGlobalCellOrigin } from "./region-topology.js";
import {
  deriveHydraulicHead,
  derivePermeability,
  derivePorosity,
  precipitationAt,
  sampleWorldConditions,
} from "./world-scale.js";
import {
  BUILD_RECIPES,
  DEFAULT_SIMULATION_CONFIG,
  type Agent,
  type AgentTask,
  type BuildTask,
  type CommandReceipt,
  emptyInventory,
  inventoryTotal,
  manhattanDistance,
  type GridPosition,
  type Inventory,
  positionKey,
  type ResourceKind,
  RESOURCE_KINDS,
  samePosition,
  type SimulationConfig,
  type Structure,
  type StructureType,
  type Tile,
  type WorldCommand,
  type WorldEvent,
  type WorldState,
} from "./protocol.js";
import { demographicWorkRecoveryReasons } from "./demography.js";
import { createRandom } from "./prng.js";
import {
  activeFactionStructures,
  ensureTileElevations,
  ensureTileTerrainLayers,
  getAgent,
  getFaction,
  getStructure,
  getTile,
  inBounds,
  isPassable,
  migrateWorldToHexGrid,
} from "./world.js";

export interface SimulationResult {
  state: WorldState;
  receipts: CommandReceipt[];
}

// Per-tick crowding bookkeeping shared by every movement call. `occupancy` is
// rebuilt once per tick instead of scanning the population on each move, and is
// updated as BOTs actually depart, so both the departure queue and the existing
// route crowding tie-break observe the same live picture.
interface CrowdFlow {
  occupancy: Map<string, number>;
  departures: Map<string, number>;
}

const NEIGHBORS: readonly GridPosition[] = HEX_GRID_STEPS;
const HYDROLOGY_NEIGHBORS: readonly GridPosition[] = HEX_GRID_STEPS;

const WATER_MOISTURE_RADIUS = 4;
const HYDROLOGY_EPSILON = 1e-6;
const TERRAIN_EVOLUTION_INTERVAL = 120;
const WATER_BALANCE_INTERVAL = 12;
// #25 Phase 3: lateral groundwater flux scale. Kept <= 0.05 so one 12-tick
// water step moves only a small fraction of the head gradient per edge;
// the per-cell outflow normalization below is the hard conservation bound.
const GROUNDWATER_CONDUCTIVITY_SCALE = 0.05;
const SPRING_DISCHARGE_COEFFICIENT = 0.15;
const SURFACE_WATER_CAP = 0.05;
const EROSION_SLOPE_SCALE = 0.18;
const MAX_EROSION_TRANSFER = 0.001;
const MAX_BEDROCK_EROSION_TRANSFER = MAX_EROSION_TRANSFER * 0.2;
export const UPLIFT_INTERVAL = 1200;
export const MAX_UPLIFT_PER_EVENT = 0.001;
const LANDSLIDE_SLOPE_REF = 0.15;
const LANDSLIDE_SOIL_REF = 0.06;
const LANDSLIDE_THRESHOLD = 0.8;
const LANDSLIDE_MIN_DOWNSLOPE = 0.12;
const MAX_LANDSLIDE_TRANSFER = 0.01;
const SETTLEMENT_RESIDENT_CAPACITY_PER_CAMP = 6;
const SETTLEMENT_CAMP_MIN_SPACING = 2;
const GATHER_BASE_AMOUNT = 2;
const GATHER_CROWDING_THRESHOLD = 3;
const GATHER_CROWDED_AMOUNT = 1;
const DEPOSIT_CROWDING_THRESHOLD = 3;
const DEPOSIT_CROWDED_THROUGHPUT = 3;
// High density must cost something on the movement side too. Once several BOTs
// share one logical hex, only a bounded number of them may leave that hex per
// tick; the rest queue behind them instead of streaming out for free. The queue
// order is the agent id order, so a crowded hex always drains the same way and
// no persisted state is added.
const MOVE_CROWDING_THRESHOLD = 3;
const MOVE_CROWDED_DEPARTURES_PER_TICK = 2;
const AUTONOMOUS_REMOTE_TRADE_TTL = 72;
const WATER_MOISTURE_OFFSETS = (() => {
  const offsets: { dx: number; dy: number; influence: number }[] = [];
  for (let dy = -WATER_MOISTURE_RADIUS; dy <= WATER_MOISTURE_RADIUS; dy += 1) {
    for (let dx = -WATER_MOISTURE_RADIUS; dx <= WATER_MOISTURE_RADIUS; dx += 1) {
      const distance = hexGridDistance({ x: 0, y: 0 }, { x: dx, y: dy });
      if (distance === 0 || distance > WATER_MOISTURE_RADIUS) continue;
      offsets.push({
        dx,
        dy,
        influence: (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
      });
    }
  }
  return offsets;
})();

function tileElevation(tile: Tile | undefined): number | undefined {
  const elevation = tile?.elevation;
  return Number.isFinite(elevation ?? Number.NaN) ? elevation : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getTileGlobalPosition(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  tile: Tile,
): { globalX: number; globalY: number; originX: number; originY: number } {
  const origin = (state as any).regionId
    ? regionGlobalCellOrigin((state as any).regionId, state.width, state.height)
    : undefined;
  const originX = origin?.x ?? 0;
  const originY = origin?.y ?? 0;
  return {
    globalX: originX + tile.x,
    globalY: originY + tile.y,
    originX,
    originY,
  };
}

function soilMoistureCapacityFrom(porosity: number, soilThickness: number): number {
  return Math.max(0.01, Math.min(0.5, porosity * (0.6 + soilThickness * 1.8)));
}

function soilMoistureCapacity(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  tile: Tile,
): number {
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const seed = (state as any).seed ?? 0;
  const conditions = sampleWorldConditions(seed, globalX, globalY);
  const porosity = derivePorosity(seed, globalX, globalY, conditions.elevation);
  const soilThickness = tile.soilThickness ?? 0.01;
  return soilMoistureCapacityFrom(porosity, soilThickness);
}

export function groundwaterHeadAt(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  tile: Tile,
): number {
  if (tile.terrain === "water" || !inBounds(state as Pick<WorldState, "width" | "height">, tile)) {
    return 0;
  }
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const seed = (state as any).seed ?? 0;
  const conditions = sampleWorldConditions(seed, globalX, globalY);
  const porosity = derivePorosity(seed, globalX, globalY, conditions.elevation);
  // #25 Phase 2 (corrected): head from saturated-zone storage, not soilMoisture.
  const storage = Math.max(0, tile.groundwaterStorage ?? 0);
  return deriveHydraulicHead(
    tile.bedrockElevation,
    tile.soilThickness,
    storage,
    porosity,
  );
}

export function flowTargetAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): GridPosition | undefined {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (tile === undefined || tile.terrain === "water" || elevation === undefined) return undefined;

  const candidates = HYDROLOGY_NEIGHBORS.flatMap((delta) => {
    const target = { x: position.x + delta.x, y: position.y + delta.y };
    const neighbor = getTile(state, target);
    const neighborElevation = tileElevation(neighbor);
    if (neighbor === undefined || neighborElevation === undefined) return [];
    const drop = elevation - neighborElevation;
    if (drop <= HYDROLOGY_EPSILON) return [];
    return [{ target, elevation: neighborElevation, gradient: drop }];
  });

  const best = candidates.sort((a, b) =>
    b.gradient - a.gradient ||
    a.elevation - b.elevation ||
    a.target.y - b.target.y ||
    a.target.x - b.target.x
  )[0];
  return best === undefined ? undefined : best.target;
}

function buildDrainageMap(
  state: Pick<WorldState, "width" | "height" | "tiles">,
): Map<string, number> {
  const catchment = new Map<string, number>();
  for (const tile of state.tiles) catchment.set(positionKey(tile), 1);

  const ordered = [...state.tiles].sort((a, b) =>
    (tileElevation(b) ?? 0) - (tileElevation(a) ?? 0) ||
    a.y - b.y ||
    a.x - b.x
  );
  for (const tile of ordered) {
    if (tile.terrain === "water") continue;
    const target = tile.flowTo ?? flowTargetAt(state, tile);
    if (target === undefined) continue;
    const sourceKey = positionKey(tile);
    const targetKey = positionKey(target);
    catchment.set(targetKey, (catchment.get(targetKey) ?? 1) + (catchment.get(sourceKey) ?? 1));
  }

  const landMaximum = state.tiles
    .filter((tile) => tile.terrain !== "water")
    .reduce((maximum, tile) => Math.max(maximum, catchment.get(positionKey(tile)) ?? 1), 1);
  const scale = Math.log1p(Math.max(0, landMaximum - 1));
  const drainage = new Map<string, number>();
  for (const tile of state.tiles) {
    if (tile.terrain === "water") {
      drainage.set(positionKey(tile), 1);
      continue;
    }
    const upstream = Math.max(1, catchment.get(positionKey(tile)) ?? 1);
    drainage.set(
      positionKey(tile),
      scale > 0 ? Math.min(1, Math.log1p(upstream - 1) / scale) : 0,
    );
  }
  return drainage;
}

export function drainageAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): number {
  const tile = getTile(state, position);
  if (tile === undefined) return 0;
  const stored = tile.drainage;
  if (Number.isFinite(stored ?? Number.NaN)) return Math.max(0, Math.min(1, stored ?? 0));
  return buildDrainageMap(state).get(positionKey(position)) ?? 0;
}

export function terrainErosionPressureAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): number {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (tile === undefined || tile.terrain === "water" || elevation === undefined) return 0;
  const targetPosition = tile.flowTo ?? flowTargetAt(state, position);
  if (targetPosition === undefined) return 0;
  const target = getTile(state, targetPosition);
  const targetElevation = tileElevation(target);
  if (target === undefined || targetElevation === undefined) return 0;

  const slope = Math.max(0, elevation - targetElevation);
  if (slope <= HYDROLOGY_EPSILON) return 0;

  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? Math.max(0, Math.min(1, tile.resource.amount / tile.resource.maxAmount))
      : 0;
  const exposure = 1 - vegetationCover * 0.8;
  const drainage = drainageAt(state, position);
  return Math.max(
    0,
    Math.min(1, drainage * Math.min(1, slope / EROSION_SLOPE_SCALE) * exposure),
  );
}

export interface WaterBalanceLedger {
  precipitation: number;
  infiltration: number;
  drying: number;
  overflow: number;
  percolation: number;
  springDischarge: number;
  routed: number;
  surfaceWaterSpill: number;
  boundaryFluxTotal: number;
  // Per-tile percolation (soilMoisture -> groundwaterStorage recharge), exposed
  // as a ledger because Phase 3 lateral flux makes per-tile groundwaterStorage
  // delta an unreliable percolation proxy.
  percolationByTile: Map<string, number>;
  // Per-tile spring discharge (groundwater -> surface return, Phase 4)
  springDischargeByTile: Map<string, number>;
  streamInflowByTile: Map<string, number>;
  boundaryFluxByTile: Map<string, number>;
  flow: GroundwaterFlowLedger;
}

type BoundaryHaloEntry = {
  sourcePosition: { x: number; y: number };
  direction: string;
  neighborRegionId: string;
  neighborPosition: { x: number; y: number };
  tile?: Tile;
};

function haloKeyLocal(position: { x: number; y: number }, direction: string): string {
  return `${position.x},${position.y}:${direction}`;
}

export function updateTileSoilMoisture(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId" | "tick">,
  haloOrOptions?: readonly BoundaryHaloEntry[] | { halo?: readonly BoundaryHaloEntry[] },
): WaterBalanceLedger | undefined {
  ensureTileTerrainLayers(state as Pick<WorldState, "width" | "height" | "tiles">);
  const seed = (state as any).seed ?? 0;
  const tick = (state as any).tick ?? 0;
  if (tick % WATER_BALANCE_INTERVAL !== 0) return undefined;
  let haloList: readonly BoundaryHaloEntry[] | undefined;
  if (Array.isArray(haloOrOptions)) {
    haloList = haloOrOptions;
  } else if (haloOrOptions && typeof haloOrOptions === "object" && "halo" in haloOrOptions) {
    haloList = (haloOrOptions as { halo?: readonly BoundaryHaloEntry[] }).halo;
  }
  // Snapshot heads before any modifications for boundary flux symmetry (only if halo present)
  const boundarySelfHeadSnapshot = new Map<string, number>();
  if (haloList && haloList.length > 0) {
    for (const tile of state.tiles) {
      if (tile.terrain === "water" || !inBounds(state as Pick<WorldState, "width" | "height">, tile)) continue;
      boundarySelfHeadSnapshot.set(positionKey(tile), groundwaterHeadAt(state, tile));
    }
  }

  const ledger: WaterBalanceLedger = {
    precipitation: 0,
    infiltration: 0,
    drying: 0,
    overflow: 0,
    percolation: 0,
    springDischarge: 0,
    routed: 0,
    surfaceWaterSpill: 0,
    boundaryFluxTotal: 0,
    percolationByTile: new Map<string, number>(),
    springDischargeByTile: new Map<string, number>(),
    streamInflowByTile: new Map<string, number>(),
    boundaryFluxByTile: new Map<string, number>(),
    flow: { totalFlux: 0, deltaByTile: new Map<string, number>() },
  };

  for (const tile of state.tiles) {
    if (tile.terrain === "water") {
      tile.soilMoisture = 1;
      tile.soilMoistureOverflow = 0;
      tile.groundwaterStorage = 0;
      if (tile.surfaceWater === undefined || !Number.isFinite(tile.surfaceWater)) {
        tile.surfaceWater = 0;
      }
      tile.surfaceWater = Math.max(0, Math.min(SURFACE_WATER_CAP, tile.surfaceWater));
      continue;
    }
    // land tiles must not carry surfaceWater store
    if (tile.surfaceWater !== undefined) delete tile.surfaceWater;
    if (!inBounds(state as Pick<WorldState, "width" | "height">, tile)) continue;
    const { globalX, globalY } = getTileGlobalPosition(state, tile);
    // Single seed-field evaluation pass per tile per balance step
    const conditions = sampleWorldConditions(seed, globalX, globalY);
    const permeability = derivePermeability(seed, globalX, globalY, conditions.elevation, conditions.slope);
    const porosity = derivePorosity(seed, globalX, globalY, conditions.elevation);
    const soilThickness = Math.max(0, tile.soilThickness ?? 0.01);
    const capacity = Math.max(0.01, Math.min(0.5, porosity * (0.6 + soilThickness * 1.8)));

    if (tile.soilMoisture === undefined || !Number.isFinite(tile.soilMoisture)) {
      // delayed initialization from derived moisture (no feedback loop)
      const baseMoisture = 0.04 + (1 - conditions.elevation) * 0.09 + conditions.wetness * 0.2;
      tile.soilMoisture = clamp01(baseMoisture) * capacity * 0.6;
    }
    if (tile.groundwaterStorage === undefined || !Number.isFinite(tile.groundwaterStorage)) {
      tile.groundwaterStorage = 0;
    }

    const precip = precipitationAt(seed, globalX, globalY, tick) * WATER_BALANCE_INTERVAL;
    ledger.precipitation += precip;
    const currentMoisture = Math.max(0, tile.soilMoisture ?? 0);
    const infiltration = precip * permeability * (1 - clamp01(currentMoisture / Math.max(1e-6, capacity)));
    const runoff = Math.max(0, precip - infiltration);

    // Drying term: relax toward seed-derived equilibrium (loss only for master balance conservation)
    const equilibriumFrac = clamp01(0.15 + conditions.wetness * 0.35 + (1 - conditions.slope) * 0.1 - conditions.temperature * 0.08);
    const equilibrium = equilibriumFrac * capacity;
    const dryingRate = 0.06 + (1 - conditions.wetness) * 0.04;
    const drying = Math.max(0, Math.min(currentMoisture + infiltration, (currentMoisture - equilibrium) * dryingRate));

    let moisture = currentMoisture + infiltration - drying;
    let satOverflow = 0;
    ledger.infiltration += infiltration;
    ledger.drying += drying;

    // #25 Phase 2 (corrected): percolation moves excess above field capacity from
    // soil moisture (unsaturated zone) to groundwater storage (saturated zone).
    const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
    const surface = Math.max(bedrock, tile.elevation ?? (bedrock + soilThickness));
    const maxStorage = Math.max(0, porosity * Math.max(0, surface - bedrock)); // pore cap
    const fieldCapacity = capacity * 0.6;
    const percRate = 0.08; // <= 0.1/step
    let storage = Math.max(0, tile.groundwaterStorage ?? 0);
    const percolationPotential = percRate * permeability * Math.max(0, moisture - fieldCapacity);
    const percolation = Math.min(percolationPotential, Math.max(0, moisture), Math.max(0, maxStorage - storage));
    moisture -= percolation;
    storage += percolation;

    if (moisture > capacity) {
      satOverflow = moisture - capacity;
      moisture = capacity;
    }
    if (moisture < 0) moisture = 0;
    // Percolation inflow is bounded by (maxStorage - storage), so storage should not
    // exceed maxStorage from this step. Pre-existing over-cap excess is left for
    // spring discharge to resolve (keeps Δgw = percolation + flowNet - spring).
    if (storage < 0) storage = 0;

    tile.soilMoisture = moisture;
    tile.groundwaterStorage = storage;
    // Explicit overflow accounting (pending pool inflow: runoff + saturation overflow)
    // Accumulate into existing pending pool (preserved across steps for terminal depressions)
    const overflow = runoff + satOverflow;
    tile.soilMoistureOverflow = (tile.soilMoistureOverflow ?? 0) + overflow;
    ledger.overflow += overflow;
    ledger.percolation += percolation;
    ledger.percolationByTile.set(positionKey(tile), percolation);
  }

  // #25 Phase 3: after recharge, relax the saturated zone laterally inside the
  // same water balance gate. This is a closed land-only system; springs/rivers
  // (Phase 4) are the only path back to the surface.
  ledger.flow = applyGroundwaterFlow(state);

  // #25 Phase 4: spring discharge where groundwater head reaches or exceeds
  // the surface. Discharge is removed from groundwater storage (conserved) and
  // credited to soil moisture / pending overflow in the same step.
  applySpringDischarge(state, ledger);

  // #25 Phase 5: route pending overflow along flowTo chains to water tiles.
  routePendingOverflowToSurfaceWater(state, ledger);

  // #25 Phase 6: derive boundary groundwater flux to ghost tiles (observe only, no storage application)
  if (haloList && haloList.length > 0) {
    const haloLookup = new Map<string, BoundaryHaloEntry>();
    for (const entry of haloList) {
      haloLookup.set(haloKeyLocal(entry.sourcePosition, entry.direction), entry);
    }
    const seed = (state as any).seed ?? 0;
    const width = (state as any).width ?? 0;
    const height = (state as any).height ?? 0;
    for (const tile of state.tiles) {
      if (tile.terrain === "water" || !inBounds(state as Pick<WorldState, "width" | "height">, tile)) {
        continue;
      }
      const selfHead = boundarySelfHeadSnapshot.get(positionKey(tile)) ?? groundwaterHeadAt(state, tile);
      const { globalX: selfGx, globalY: selfGy } = getTileGlobalPosition(state, tile);
      const selfConditions = sampleWorldConditions(seed, selfGx, selfGy);
      const selfPorosity = derivePorosity(seed, selfGx, selfGy, selfConditions.elevation);
      const selfPermeability = derivePermeability(seed, selfGx, selfGy, selfConditions.elevation, selfConditions.slope);
      for (let d = 0; d < HEX_GRID_DIRECTIONS.length; d++) {
        const dir = HEX_GRID_DIRECTIONS[d] as any;
        if (dir === undefined) continue;
        const key = haloKeyLocal({ x: tile.x, y: tile.y }, dir);
        const ghostEntry = haloLookup.get(key);
        if (!ghostEntry) continue;
        const ghostTile = ghostEntry.tile;
        if (!ghostTile || ghostTile.terrain === "water") continue;
        const neighborRegionId = ghostEntry.neighborRegionId;
        const neighborPos = ghostEntry.neighborPosition;
        const neighborOrigin = regionGlobalCellOrigin(neighborRegionId, width, height);
        const ghostGx = (neighborOrigin?.x ?? 0) + neighborPos.x;
        const ghostGy = (neighborOrigin?.y ?? 0) + neighborPos.y;
        const ghostConditions = sampleWorldConditions(seed, ghostGx, ghostGy);
        const ghostPorosity = derivePorosity(seed, ghostGx, ghostGy, ghostConditions.elevation);
        const ghostPermeability = derivePermeability(seed, ghostGx, ghostGy, ghostConditions.elevation, ghostConditions.slope);
        const ghostHead = deriveHydraulicHead(
          ghostTile.bedrockElevation,
          ghostTile.soilThickness,
          Math.max(0, ghostTile.groundwaterStorage ?? 0),
          ghostPorosity,
        );
        const drop = selfHead - ghostHead;
        if (Math.abs(drop) <= HYDROLOGY_EPSILON) continue;
        const fluxMagnitude = Math.min(selfPermeability, ghostPermeability) * GROUNDWATER_CONDUCTIVITY_SCALE * Math.abs(drop);
        if (fluxMagnitude <= 0) continue;
        const flux = drop > 0 ? fluxMagnitude : -fluxMagnitude;
        const cellKey = positionKey(tile);
        ledger.boundaryFluxByTile.set(cellKey, (ledger.boundaryFluxByTile.get(cellKey) ?? 0) + flux);
        ledger.boundaryFluxTotal += flux;
      }
    }
  }

  return ledger;
}

export function boundaryPendingAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  haloOrOptions?: readonly BoundaryHaloEntry[] | { halo?: readonly BoundaryHaloEntry[] },
): number {
  const tile = getTile(state, position);
  if (tile === undefined || tile.terrain === "water" || !inBounds(state, position)) {
    return 0;
  }
  let haloList: readonly BoundaryHaloEntry[] | undefined;
  if (Array.isArray(haloOrOptions)) {
    haloList = haloOrOptions;
  } else if (haloOrOptions && typeof haloOrOptions === "object" && "halo" in haloOrOptions) {
    haloList = (haloOrOptions as { halo?: readonly BoundaryHaloEntry[] }).halo;
  }
  if (!haloList || haloList.length === 0) {
    return Math.max(0, tile.soilMoistureOverflow ?? 0);
  }
  const haloLookup = new Map<string, BoundaryHaloEntry>();
  for (const entry of haloList) {
    haloLookup.set(haloKeyLocal(entry.sourcePosition, entry.direction), entry);
  }
  for (let d = 0; d < HEX_GRID_DIRECTIONS.length; d++) {
    const dir = HEX_GRID_DIRECTIONS[d] as any;
    if (dir === undefined) continue;
    const key = haloKeyLocal(position, dir);
    const ghostEntry = haloLookup.get(key);
    if (ghostEntry && ghostEntry.tile && ghostEntry.tile.terrain !== "water") {
      return Math.max(0, tile.soilMoistureOverflow ?? 0);
    }
  }
  return Math.max(0, tile.soilMoistureOverflow ?? 0);
}

export interface GroundwaterFlowLedger {
  totalFlux: number;
  // Net signed change of groundwaterStorage per tile key (negative = source).
  deltaByTile: Map<string, number>;
}

export function routePendingOverflowToSurfaceWater(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  ledger?: Pick<WaterBalanceLedger, "routed" | "surfaceWaterSpill" | "streamInflowByTile">,
): void {
  // Collect all pending overflow from land cells (100% send out)
  const pending: Array<{ key: string; amount: number }> = [];
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const amount = Math.max(0, tile.soilMoistureOverflow ?? 0);
    if (amount <= 0) continue;
    pending.push({ key: positionKey(tile), amount });
    tile.soilMoistureOverflow = 0;
  }

  const tileByKey = new Map<string, Tile>();
  for (const tile of state.tiles) {
    if (inBounds(state, tile)) tileByKey.set(positionKey(tile), tile);
  }

  for (const entry of pending) {
    let currentKey = entry.key;
    let amount = entry.amount;
    if (amount <= 0) continue;
    const visited = new Set<string>();
    let delivered = false;

    while (amount > 1e-15) {
      if (visited.has(currentKey)) {
        // Safety: keep at current cell (terminal pool)
        const tile = tileByKey.get(currentKey);
        if (tile && tile.terrain !== "water") {
          tile.soilMoistureOverflow = (tile.soilMoistureOverflow ?? 0) + amount;
        }
        break;
      }
      visited.add(currentKey);
      const tile = tileByKey.get(currentKey);
      if (!tile) {
        // Out of known tiles / boundary - drop to nowhere is wrong; but cannot store.
        // Keep accounting by treating as spill? Better: cannot happen for in-bounds start.
        break;
      }
      if (tile.terrain === "water") {
        const before = Math.max(0, tile.surfaceWater ?? 0);
        const added = Math.min(amount, Math.max(0, SURFACE_WATER_CAP - before));
        const spill = amount - added;
        tile.surfaceWater = before + added;
        if (ledger) {
          ledger.routed += amount;
          ledger.surfaceWaterSpill += spill;
          const k = positionKey(tile);
          ledger.streamInflowByTile.set(k, (ledger.streamInflowByTile.get(k) ?? 0) + added);
        }
        delivered = true;
        break;
      }

      const target = tile.flowTo;
      if (!target) {
        // Terminal land cell (depression/boundary end) - keep in pending pool
        tile.soilMoistureOverflow = (tile.soilMoistureOverflow ?? 0) + amount;
        break;
      }
      const next = getTile(state, target);
      if (!next || !inBounds(state, target)) {
        // Region boundary / out of bounds - Phase 6; keep in current cell's pending pool
        tile.soilMoistureOverflow = (tile.soilMoistureOverflow ?? 0) + amount;
        break;
      }
      currentKey = positionKey(next);
    }
  }
}

export function applySpringDischarge(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  ledger?: Pick<WaterBalanceLedger, "springDischarge" | "springDischargeByTile" | "overflow">,
): number {
  ensureTileTerrainLayers(state as Pick<WorldState, "width" | "height" | "tiles">);
  const seed = (state as any).seed ?? 0;
  let totalDischarge = 0;

  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state as Pick<WorldState, "width" | "height">, tile)) {
      continue;
    }
    const storage = Math.max(0, tile.groundwaterStorage ?? 0);
    if (storage <= 0) continue;

    const { globalX, globalY } = getTileGlobalPosition(state, tile);
    const conditions = sampleWorldConditions(seed, globalX, globalY);
    const porosity = derivePorosity(seed, globalX, globalY, conditions.elevation);
    const soilThickness = Math.max(0, tile.soilThickness ?? 0.01);
    const capacity = soilMoistureCapacityFrom(porosity, soilThickness);
    const head = deriveHydraulicHead(
      tile.bedrockElevation,
      tile.soilThickness,
      storage,
      porosity,
    );
    const surface = Number.isFinite(tile.elevation ?? Number.NaN) ? (tile.elevation ?? 0) : 0;
    const excessHead = head - surface;
    if (excessHead <= 0) continue;

    // Discharge is proportional to excess head and bounded by available storage.
    // Water is removed from groundwater (conserved). Per DSH brief, credit the
    // discharged water to soilMoisture in the same step (capacity bounded);
    // excess goes to existing overflow accounting.
    const discharge = Math.min(storage, excessHead * SPRING_DISCHARGE_COEFFICIENT * porosity);
    if (discharge <= 0) continue;

    tile.groundwaterStorage = storage - discharge;
    let moisture = Math.max(0, tile.soilMoisture ?? 0) + discharge;
    if (moisture > capacity) {
      const overflow = moisture - capacity;
      moisture = capacity;
      if (ledger) ledger.overflow += overflow;
      tile.soilMoistureOverflow = (tile.soilMoistureOverflow ?? 0) + overflow;
    }
    tile.soilMoisture = moisture;

    totalDischarge += discharge;
    if (ledger) {
      ledger.springDischarge += discharge;
      ledger.springDischargeByTile.set(positionKey(tile), discharge);
    }
  }

  return totalDischarge;
}

export function applyGroundwaterFlow(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  conductivityAt?: (
    state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
    tileA: Tile,
    tileB: Tile,
  ) => number,
): GroundwaterFlowLedger {
  ensureTileTerrainLayers(state as Pick<WorldState, "width" | "height" | "tiles">);
  const seed = (state as any).seed ?? 0;
  const permeability = new Map<string, number>();
  const permeabilityFor = (tile: Tile): number => {
    const key = positionKey(tile);
    let value = permeability.get(key);
    if (value === undefined) {
      const { globalX, globalY } = getTileGlobalPosition(state, tile);
      const conditions = sampleWorldConditions(seed, globalX, globalY);
      value = derivePermeability(seed, globalX, globalY, conditions.elevation, conditions.slope);
      permeability.set(key, value);
    }
    return value;
  };
  const defaultConductivity = (tileA: Tile, tileB: Tile): number =>
    Math.min(permeabilityFor(tileA), permeabilityFor(tileB)) * GROUNDWATER_CONDUCTIVITY_SCALE;

  // Head snapshot taken before any transfer: no intra-step cascading, same
  // discipline as terrain erosion's delta map.
  const head = new Map<string, number>();
  const storage = new Map<string, number>();
  const landIndex = new Map<string, Tile>();
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state as Pick<WorldState, "width" | "height">, tile)) continue;
    const key = positionKey(tile);
    landIndex.set(key, tile);
    head.set(key, groundwaterHeadAt(state, tile));
    storage.set(key, Math.max(0, tile.groundwaterStorage ?? 0));
  }

  interface EdgeFlux { source: string; target: string; flux: number }
  const edges: EdgeFlux[] = [];
  const requestedOut = new Map<string, number>();
  for (const [sourceKey, tile] of landIndex) {
    const headI = head.get(sourceKey) ?? 0;
    for (const delta of HYDROLOGY_NEIGHBORS) {
      const target = getTile(state, { x: tile.x + delta.x, y: tile.y + delta.y });
      if (target === undefined || target.terrain === "water") continue;
      const targetKey = positionKey(target);
      if (!landIndex.has(targetKey)) continue;
      const drop = headI - (head.get(targetKey) ?? 0);
      if (drop <= 0) continue;
      const conductivity = conductivityAt !== undefined
        ? Math.max(0, conductivityAt(state, tile, target))
        : defaultConductivity(tile, target);
      const flux = conductivity * drop;
      if (flux <= HYDROLOGY_EPSILON) continue;
      edges.push({ source: sourceKey, target: targetKey, flux });
      requestedOut.set(sourceKey, (requestedOut.get(sourceKey) ?? 0) + flux);
    }
  }

  // Normalize so total outflow never exceeds the cell's snapshot storage.
  const delta = new Map<string, number>();
  let totalFlux = 0;
  for (const edge of edges) {
    const requested = requestedOut.get(edge.source) ?? 0;
    const available = storage.get(edge.source) ?? 0;
    const applied = requested > available ? edge.flux * (available / requested) : edge.flux;
    if (applied <= 0) continue;
    totalFlux += applied;
    delta.set(edge.source, (delta.get(edge.source) ?? 0) - applied);
    delta.set(edge.target, (delta.get(edge.target) ?? 0) + applied);
  }

  for (const [key, tile] of landIndex) {
    const change = delta.get(key);
    if (change === undefined || change === 0) continue;
    tile.groundwaterStorage = Math.max(0, (storage.get(key) ?? 0) + change);
  }
  return { totalFlux, deltaByTile: delta };
}

export function updateTileHydrology(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId" | "tick">,
): void {
  ensureTileElevations(state);
  ensureTileTerrainLayers(state);
  updateTileSoilMoisture(state);
  for (const tile of state.tiles) {
    const target = flowTargetAt(state, tile);
    if (target === undefined) delete tile.flowTo;
    else tile.flowTo = target;
  }
  const drainage = buildDrainageMap(state);
  for (const tile of state.tiles) tile.drainage = drainage.get(positionKey(tile)) ?? 0;
  for (const tile of state.tiles) tile.erosionPressure = terrainErosionPressureAt(state, tile);
}

export function upliftRateAt(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  tile: Tile,
): number {
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const seed = (state.seed ?? 0) >>> 0;
  const p1 = (((seed * 2654435761) >>> 0) / 4294967296) * Math.PI * 2;
  const p2 = ((((seed ^ 0x9e3779b9) * 2246822519) >>> 0) / 4294967296) * Math.PI * 2;
  const x = globalX + 0.5;
  const y = globalY + 0.5;
  // Low-frequency continuous uplift field (#66-style global projection), [0, MAX_UPLIFT_PER_EVENT]
  const v = 0.5 + 0.28 * Math.sin(x / 97 + p1) + 0.22 * Math.cos(y / 83 + x / 211 + p2);
  return Math.max(0, Math.min(1, v)) * MAX_UPLIFT_PER_EVENT;
}

export type UpliftRateAt = typeof upliftRateAt;

export function applyTerrainUplift(
  state: WorldState,
  rateAt: (state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">, tile: Tile) => number = upliftRateAt,
): number {
  ensureTileTerrainLayers(state);
  let total = 0;
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const u = rateAt(state, tile);
    if (u <= HYDROLOGY_EPSILON) continue;
    const bedrock = tile.bedrockElevation ?? 0;
    const soil = Math.max(0, tile.soilThickness ?? 0);
    // Contract (Phase 4): bedrockElevation += u and elevation += u simultaneously; soil unchanged.
    tile.bedrockElevation = bedrock + u;
    tile.soilThickness = soil;
    tile.elevation = tile.bedrockElevation + soil;
    total += u;
  }
  if (total > 0) updateTileHydrology(state);
  return total;
}

export interface TerrainErosionLedger {
  removed: number;
  deposited: number;
  waterExport: number;
  clampLoss: number;
  bedrockRemoved: number;
}

export function applyTerrainErosion(state: WorldState): TerrainErosionLedger {
  ensureTileTerrainLayers(state);
  const soilDelta = new Map<string, number>();
  const bedrockDelta = new Map<string, number>();
  const exportDelta = new Map<string, number>(); // soil/sediment-equivalent export
  const bedrockExportDelta = new Map<string, number>();
  let totalSoilRemoved = 0;
  let totalBedrockRemoved = 0;

  for (const tile of state.tiles) {
    if (tile.terrain === "water" || tile.flowTo === undefined) continue;
    if (!inBounds(state, tile)) continue;
    const sourceBedrock = tile.bedrockElevation ?? 0;
    const sourceSoil = Math.max(0, tile.soilThickness ?? 0);
    const sourceElevation = sourceBedrock + sourceSoil;
    const target = getTile(state, tile.flowTo);
    if (target === undefined) continue;
    const targetBedrock = target.terrain === "water" ? 0 : (target.bedrockElevation ?? 0);
    const targetSoil = target.terrain === "water" ? 0 : Math.max(0, target.soilThickness ?? 0);
    const targetElevation = target.terrain === "water" ? 0 : targetBedrock + targetSoil;

    // BOT work happens after the tick's hydrology update. Read current cover so
    // harvesting on an erosion tick affects this transfer, rather than waiting
    // another 120 ticks for a cached vegetation-dependent pressure to catch up.
    // Keep the existing flowTo/drainage inputs; halo runoff is derived separately.
    const pressure = terrainErosionPressureAt(state, tile);
    if (pressure <= 0) continue;

    const drop = sourceElevation - targetElevation;
    if (drop <= HYDROLOGY_EPSILON) continue;

    const sourceKey = positionKey(tile);
    if (sourceSoil > HYDROLOGY_EPSILON) {
      // Phase 2: move soil (stateful). Bedrock is fixed while soil remains.
      const maxBySoil = Math.max(0, sourceSoil);
      const maxBySurface = Math.max(0, sourceElevation - 0.01);
      const transfer = Math.min(
        MAX_EROSION_TRANSFER * pressure,
        drop * 0.2,
        maxBySoil,
        maxBySurface,
      );
      if (transfer <= HYDROLOGY_EPSILON) continue;

      soilDelta.set(sourceKey, (soilDelta.get(sourceKey) ?? 0) - transfer);
      totalSoilRemoved += transfer;
      if (target.terrain !== "water" && inBounds(state, target)) {
        const targetKey = positionKey(target);
        soilDelta.set(targetKey, (soilDelta.get(targetKey) ?? 0) + transfer);
      } else {
        exportDelta.set(sourceKey, (exportDelta.get(sourceKey) ?? 0) + transfer);
      }
    } else {
      // Phase 3: only when soil is depleted, erode bedrock at 1/5 rate.
      const maxByBedrock = Math.max(0, sourceBedrock);
      const maxBySurface = Math.max(0, sourceElevation - 0.01);
      const transfer = Math.min(
        MAX_BEDROCK_EROSION_TRANSFER * pressure,
        drop * 0.2,
        maxByBedrock,
        maxBySurface,
      );
      if (transfer <= HYDROLOGY_EPSILON) continue;

      bedrockDelta.set(sourceKey, (bedrockDelta.get(sourceKey) ?? 0) - transfer);
      totalBedrockRemoved += transfer;
      if (target.terrain !== "water" && inBounds(state, target)) {
        // Eroded bedrock deposits downstream as sediment (soil)
        const targetKey = positionKey(target);
        soilDelta.set(targetKey, (soilDelta.get(targetKey) ?? 0) + transfer);
      } else {
        bedrockExportDelta.set(sourceKey, (bedrockExportDelta.get(sourceKey) ?? 0) + transfer);
      }
    }
  }

  if (totalSoilRemoved <= 0 && totalBedrockRemoved <= 0) {
    return { removed: 0, deposited: 0, waterExport: 0, clampLoss: 0, bedrockRemoved: 0 };
  }

  const beforeSoil = new Map<string, number>();
  const beforeBedrock = new Map<string, number>();
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const key = positionKey(tile);
    beforeSoil.set(key, Math.max(0, tile.soilThickness ?? 0));
    beforeBedrock.set(key, Math.max(0, tile.bedrockElevation ?? 0));
  }

  for (const tile of state.tiles) {
    if (tile.terrain === "water") {
      tile.bedrockElevation = 0;
      tile.soilThickness = 0;
      tile.elevation = 0;
      continue;
    }
    if (!inBounds(state, tile)) continue;
    const key = positionKey(tile);
    let bedrock = Math.max(0, (tile.bedrockElevation ?? 0) + (bedrockDelta.get(key) ?? 0));
    let soil = Math.max(0, tile.soilThickness ?? 0) + (soilDelta.get(key) ?? 0);
    if (soil < 0) soil = 0;
    let elevation = bedrock + soil;
    if (elevation > 0.99) {
      const loss = elevation - 0.99;
      soil = Math.max(0, soil - loss);
      elevation = bedrock + soil;
    }
    tile.bedrockElevation = bedrock;
    tile.soilThickness = Math.max(0, soil);
    tile.elevation = tile.bedrockElevation + tile.soilThickness;
  }

  let removed = 0;
  let bedrockRemoved = 0;
  let deposited = 0;
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const key = positionKey(tile);
    const soilBefore = beforeSoil.get(key) ?? 0;
    const soilAfter = Math.max(0, tile.soilThickness ?? 0);
    const bedrockBefore = beforeBedrock.get(key) ?? 0;
    const bedrockAfter = Math.max(0, tile.bedrockElevation ?? 0);
    const soilDiff = soilAfter - soilBefore;
    const bedrockDiff = bedrockAfter - bedrockBefore;
    if (soilDiff < 0) removed += -soilDiff;
    if (soilDiff > 0) deposited += soilDiff;
    if (bedrockDiff < 0) bedrockRemoved += -bedrockDiff;
  }
  let plannedExport = 0;
  for (const value of exportDelta.values()) plannedExport += value;
  for (const value of bedrockExportDelta.values()) plannedExport += value;
  const totalOut = removed + bedrockRemoved;
  const waterExport = Math.min(plannedExport, Math.max(0, totalOut - deposited));
  const clampLoss = Math.max(0, totalOut - deposited - waterExport);

  updateTileHydrology(state);
  return { removed, deposited, waterExport, clampLoss, bedrockRemoved };
}

export interface LandslideLedger {
  moved: number;
  deposited: number;
  waterExport: number;
  clampLoss: number;
}

function landslideSaturationTerm(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles" | "regionId">,
  tile: Tile,
): number {
  const { globalX, globalY } = getTileGlobalPosition(state, tile);
  const seed = (state as any).seed ?? 0;
  const conditions = sampleWorldConditions(seed, globalX, globalY);
  const porosity = derivePorosity(seed, globalX, globalY, conditions.elevation);
  const capacity = soilMoistureCapacity(state, tile);
  const satSoil = clamp01(Math.max(0, tile.soilMoisture ?? 0) / Math.max(1e-6, capacity));
  const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  const surface = Number.isFinite(tile.elevation ?? Number.NaN) ? (tile.elevation as number) : bedrock + soil;
  const maxStorage = Math.max(0, porosity * Math.max(0, surface - bedrock));
  const gwFill = clamp01(Math.max(0, tile.groundwaterStorage ?? 0) / Math.max(1e-6, maxStorage));
  return clamp01(satSoil + 0.5 * gwFill);
}

function steepestDescentTarget(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  tile: Tile,
): { target: Tile; drop: number } | undefined {
  const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
  const soil = Math.max(0, tile.soilThickness ?? 0);
  const elevation = Number.isFinite(tile.elevation ?? Number.NaN) ? (tile.elevation as number) : bedrock + soil;
  let best: { target: Tile; drop: number } | undefined;
  for (const delta of HEX_GRID_STEPS) {
    const npos = { x: tile.x + delta.x, y: tile.y + delta.y };
    const neighbor = getTile(state, npos);
    if (neighbor === undefined || !inBounds(state, npos)) continue;
    const nBedrock = neighbor.terrain === "water" ? 0 : Math.max(0, neighbor.bedrockElevation ?? 0);
    const nSoil = neighbor.terrain === "water" ? 0 : Math.max(0, neighbor.soilThickness ?? 0);
    const nElev = neighbor.terrain === "water" ? 0 : (Number.isFinite(neighbor.elevation ?? Number.NaN) ? (neighbor.elevation as number) : nBedrock + nSoil);
    const drop = elevation - nElev;
    if (drop <= HYDROLOGY_EPSILON) continue;
    if (best === undefined || drop > best.drop || (Math.abs(drop - best.drop) < 1e-12 && (npos.y < best.target.y || (npos.y === best.target.y && npos.x < best.target.x)))) {
      best = { target: neighbor, drop };
    }
  }
  return best;
}

export function applyMassWasting(state: WorldState): LandslideLedger {
  ensureTileTerrainLayers(state);
  const soilDelta = new Map<string, number>();
  const exportDelta = new Map<string, number>();
  let totalMoved = 0;

  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
    const soil = Math.max(0, tile.soilThickness ?? 0);
    if (soil <= HYDROLOGY_EPSILON) continue; // bedrock landslide out of scope
    const descent = steepestDescentTarget(state, tile);
    if (descent === undefined) continue;
    const { target, drop } = descent;
    if (drop <= LANDSLIDE_MIN_DOWNSLOPE) continue;

    const slopeTerm = clamp01(drop / LANDSLIDE_SLOPE_REF);
    const soilTerm = clamp01(soil / LANDSLIDE_SOIL_REF);
    const saturationTerm = landslideSaturationTerm(state, tile);
    const instability = clamp01(slopeTerm * (0.35 + 0.65 * saturationTerm) * soilTerm);
    if (instability <= LANDSLIDE_THRESHOLD) continue;

    const instabilityExcess = clamp01((instability - LANDSLIDE_THRESHOLD) / Math.max(1e-6, 1 - LANDSLIDE_THRESHOLD));
    const elevation = bedrock + soil;
    const maxBySoil = Math.max(0, soil);
    const maxBySurface = Math.max(0, elevation - 0.01);
    const transfer = Math.min(
      MAX_LANDSLIDE_TRANSFER * (0.25 + 0.75 * instabilityExcess),
      drop * 0.35,
      maxBySoil,
      maxBySurface,
    );
    if (transfer <= HYDROLOGY_EPSILON) continue;

    const sourceKey = positionKey(tile);
    soilDelta.set(sourceKey, (soilDelta.get(sourceKey) ?? 0) - transfer);
    totalMoved += transfer;
    if (target.terrain !== "water" && inBounds(state, target)) {
      const targetKey = positionKey(target);
      soilDelta.set(targetKey, (soilDelta.get(targetKey) ?? 0) + transfer);
    } else {
      exportDelta.set(sourceKey, (exportDelta.get(sourceKey) ?? 0) + transfer);
    }
  }

  if (totalMoved <= 0) {
    return { moved: 0, deposited: 0, waterExport: 0, clampLoss: 0 };
  }

  const beforeSoil = new Map<string, number>();
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    beforeSoil.set(positionKey(tile), Math.max(0, tile.soilThickness ?? 0));
  }

  for (const tile of state.tiles) {
    if (tile.terrain === "water") {
      tile.bedrockElevation = 0;
      tile.soilThickness = 0;
      tile.elevation = 0;
      tile.groundwaterStorage = 0;
      continue;
    }
    if (!inBounds(state, tile)) continue;
    const key = positionKey(tile);
    const bedrock = Math.max(0, tile.bedrockElevation ?? 0);
    let soil = Math.max(0, tile.soilThickness ?? 0) + (soilDelta.get(key) ?? 0);
    if (soil < 0) soil = 0;
    let elevation = bedrock + soil;
    if (elevation > 0.99) {
      const loss = elevation - 0.99;
      soil = Math.max(0, soil - loss);
      elevation = bedrock + soil;
    }
    tile.bedrockElevation = bedrock;
    tile.soilThickness = soil;
    tile.elevation = bedrock + soil;
  }

  let moved = 0;
  let deposited = 0;
  for (const tile of state.tiles) {
    if (tile.terrain === "water" || !inBounds(state, tile)) continue;
    const key = positionKey(tile);
    const before = beforeSoil.get(key) ?? 0;
    const after = Math.max(0, tile.soilThickness ?? 0);
    const diff = after - before;
    if (diff < 0) moved += -diff;
    if (diff > 0) deposited += diff;
  }
  let plannedExport = 0;
  for (const value of exportDelta.values()) plannedExport += value;
  const waterExport = Math.min(plannedExport, Math.max(0, moved - deposited));
  const clampLoss = Math.max(0, moved - deposited - waterExport);

  return { moved, deposited, waterExport, clampLoss };
}

export function surfaceMoistureAt(
  state: Pick<WorldState, "width" | "height" | "tiles" | "regionId" | "seed" | "tick">,
  position: GridPosition,
): number {
  const tile = getTile(state, position);
  if (tile === undefined) return 0;
  if (tile.terrain === "water") return 1;

  let waterInfluence = 0;
  for (const offset of WATER_MOISTURE_OFFSETS) {
    const neighbor = getTile(state, {
      x: position.x + offset.dx,
      y: position.y + offset.dy,
    });
    if (neighbor?.terrain !== "water") continue;
    waterInfluence = Math.max(waterInfluence, offset.influence);
  }

  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? tile.resource.amount / tile.resource.maxAmount
      : 0;
  const elevation = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation ?? 0.5 : 0.5;
  const lowlandRetention = (1 - elevation) * 0.09;
  const runoffRetention = drainageAt(state as any, position) * 0.14;
  const base = Math.min(
    1,
    0.04 + lowlandRetention + runoffRetention + waterInfluence * 0.64 + vegetationCover * 0.16,
  );

  // Blend in persisted soilMoisture from Phase 1 (derived infiltration/storage)
  if (tile.soilMoisture !== undefined && Number.isFinite(tile.soilMoisture)) {
    try {
      const capacity = soilMoistureCapacity(state as any, tile);
      const soilFrac = clamp01((tile.soilMoisture ?? 0) / Math.max(1e-6, capacity));
      return clamp01(base * 0.7 + soilFrac * 0.4);
    } catch {
      return base;
    }
  }
  return base;
}

export function resourceRegrowthChance(state: WorldState, tile: Tile): number {
  if (tile.resource === undefined || tile.resource.kind === "stone") return 0.18;
  const moisture = surfaceMoistureAt(state, tile);
  return tile.resource.kind === "wood"
    ? Math.min(0.32, 0.08 + moisture * 0.22)
    : Math.min(0.34, 0.06 + moisture * 0.26);
}

function addEvent(
  state: WorldState,
  event: Omit<WorldEvent, "id" | "tick"> & { tick?: number },
): void {
  const sequence = state.events.length + 1;
  state.events.push({
    ...event,
    id: `event-${state.tick}-${sequence}`,
    tick: event.tick ?? state.tick,
  });
}

function commandRejected(state: WorldState, command: WorldCommand, reason: string): CommandReceipt {
  addEvent(state, {
    kind: "command_rejected",
    message: `Command ${command.id} rejected: ${reason}`,
    agentId: command.agentId,
    data: { commandId: command.id, type: command.type, reason },
  });
  return { accepted: false, commandId: command.id, tick: state.tick, reason };
}

function commandAccepted(state: WorldState, command: WorldCommand): CommandReceipt {
  addEvent(state, {
    kind: "command_accepted",
    message: `${command.agentId} accepted ${command.type}.`,
    agentId: command.agentId,
    data: { commandId: command.id, type: command.type },
  });
  return { accepted: true, commandId: command.id, tick: state.tick };
}

function isTargetValid(state: WorldState, target: GridPosition): boolean {
  return inBounds(state, target) && isPassable(state, target);
}

function taskBase(state: WorldState, config: SimulationConfig): Pick<AgentTask, "source" | "issuedAtTick" | "expiresAtTick"> {
  return {
    source: "external",
    issuedAtTick: state.tick,
    expiresAtTick: state.tick + config.externalTaskTtl,
  };
}

function applyCommand(
  state: WorldState,
  command: WorldCommand,
  config: SimulationConfig,
): CommandReceipt {
  if (state.processedCommandIds.includes(command.id)) {
    return commandRejected(state, command, "duplicate command id");
  }
  state.processedCommandIds.push(command.id);

  const agent = getAgent(state, command.agentId);
  if (agent === undefined) return commandRejected(state, command, "unknown agent");

  const base = taskBase(state, config);
  switch (command.type) {
    case "move":
      if (!isTargetValid(state, command.target)) {
        return commandRejected(state, command, "target is outside the map or impassable");
      }
      agent.task = { ...base, type: "move", target: command.target };
      agent.status = "moving by external command";
      break;
    case "gather":
      if (command.target !== undefined && !isTargetValid(state, command.target)) {
        return commandRejected(state, command, "target is outside the map or impassable");
      }
      agent.task = command.target === undefined
        ? { ...base, type: "gather", resource: command.resource }
        : { ...base, type: "gather", resource: command.resource, target: command.target };
      agent.status = `seeking ${command.resource}`;
      break;
    case "build":
      if (!isTargetValid(state, command.target)) {
        return commandRejected(state, command, "build target is outside the map or impassable");
      }
      agent.task = {
        ...base,
        type: "build",
        structureType: command.structureType,
        target: command.target,
      };
      agent.status = `preparing ${command.structureType}`;
      break;
    case "deposit":
      if (command.structureId !== undefined) {
        const structure = getStructure(state, command.structureId);
        if (
          structure === undefined ||
          structure.factionId !== agent.factionId ||
          structure.status !== "active"
        ) {
          return commandRejected(state, command, "deposit structure is not an active owned structure");
        }
      }
      agent.task = command.structureId === undefined
        ? { ...base, type: "deposit" }
        : { ...base, type: "deposit", structureId: command.structureId };
      agent.status = "returning resources";
      break;
    case "trade":
      if (command.targetAgentId === agent.id) {
        return commandRejected(state, command, "an agent cannot trade with itself");
      }
      if (getAgent(state, command.targetAgentId) === undefined) {
        return commandRejected(state, command, "unknown trade target");
      }
      agent.task = {
        ...base,
        type: "trade",
        targetAgentId: command.targetAgentId,
        offer: command.offer,
        request: command.request,
      };
      agent.status = `seeking ${command.targetAgentId} to trade`;
      break;
    case "set_autonomy":
      agent.autonomy = command.enabled;
      if (!command.enabled && agent.task?.source === "autonomy") delete agent.task;
      agent.status = command.enabled ? "autonomy enabled" : "awaiting external commands";
      addEvent(state, {
        kind: "autonomy_changed",
        message: `${agent.name} autonomy ${command.enabled ? "enabled" : "disabled"}.`,
        agentId: agent.id,
        factionId: agent.factionId,
        position: { ...agent.position },
        data: { enabled: command.enabled },
      });
      break;
    case "set_goal":
      agent.goal = command.goal;
      addEvent(state, {
        kind: "goal_changed",
        message: `${agent.name} received a new goal: ${command.goal}`,
        agentId: agent.id,
        factionId: agent.factionId,
        position: { ...agent.position },
      });
      break;
    case "clear_task":
      delete agent.task;
      agent.status = agent.autonomy ? "replanning" : "idle";
      break;
  }

  return commandAccepted(state, command);
}

function hasInventory(inventory: Inventory, cost: Inventory): boolean {
  return RESOURCE_KINDS.every((kind) => inventory[kind] >= cost[kind]);
}

function consumeInventory(inventory: Inventory, cost: Inventory): void {
  for (const kind of RESOURCE_KINDS) inventory[kind] -= cost[kind];
}

function factionCanAfford(state: WorldState, factionId: string, cost: Inventory): boolean {
  const faction = getFaction(state, factionId);
  return faction !== undefined && hasInventory(faction.resources, cost);
}

function consumeFactionResources(state: WorldState, factionId: string, cost: Inventory): boolean {
  const faction = getFaction(state, factionId);
  if (faction === undefined || !hasInventory(faction.resources, cost)) return false;

  consumeInventory(faction.resources, cost);
  const storages = activeFactionStructures(state, factionId).sort((a, b) => a.id.localeCompare(b.id));
  for (const kind of RESOURCE_KINDS) {
    let remaining = cost[kind];
    for (const structure of storages) {
      const taken = Math.min(remaining, structure.storage[kind]);
      structure.storage[kind] -= taken;
      remaining -= taken;
      if (remaining === 0) break;
    }
  }
  return true;
}

function inventoryMissingForRecipe(inventory: Inventory, type: StructureType): ResourceKind {
  const cost = BUILD_RECIPES[type].cost;
  return RESOURCE_KINDS
    .map((kind) => ({ kind, missing: Math.max(0, cost[kind] - inventory[kind]) }))
    .sort((a, b) => b.missing - a.missing || a.kind.localeCompare(b.kind))[0]?.kind ?? "wood";
}

function factionMissingForRecipe(state: WorldState, factionId: string, type: StructureType): ResourceKind {
  const faction = getFaction(state, factionId);
  if (faction === undefined) return "wood";
  return inventoryMissingForRecipe(faction.resources, type);
}

function nextStepTowards(
  state: WorldState,
  start: GridPosition,
  target: GridPosition,
  flow?: CrowdFlow,
): GridPosition {
  if (samePosition(start, target)) return start;
  if (!isPassable(state, target)) return start;

  // Keep path length authoritative, then minimize the total crowding exposure
  // among equally short routes. The previous queue-order heuristic only looked
  // at crowding on the next expansion and could commit to an empty first hex
  // whose later shortest-path cells were already packed with BOTs.
  const distanceToTarget = new Map<string, number>();
  const queue: GridPosition[] = [target];
  distanceToTarget.set(positionKey(target), 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    const currentDistance = distanceToTarget.get(positionKey(current));
    if (currentDistance === undefined) continue;
    for (const delta of NEIGHBORS) {
      const next = { x: current.x + delta.x, y: current.y + delta.y };
      const key = positionKey(next);
      if (distanceToTarget.has(key) || !isPassable(state, next)) continue;
      distanceToTarget.set(key, currentDistance + 1);
      queue.push(next);
    }
  }

  const startDistance = distanceToTarget.get(positionKey(start));
  if (startDistance === undefined) return start;

  // Count the current population once per route query, not once per visited
  // shortest-path cell. Rebuild for each mover so earlier moves in this tick
  // remain visible to later BOTs; a tick-start snapshot would change routing.
  // When the caller already maintains a live occupancy index for this tick
  // (simulate() does), reuse it so routing adds no extra population scan.
  const occupancy = flow?.occupancy ?? (() => {
    const built = new Map<string, number>();
    for (const agent of state.agents) {
      if (agent.hp <= 0) continue;
      incrementCongestion(built, positionKey(agent.position));
    }
    return built;
  })();

  const crowdingCost = new Map<string, number>();
  const minimumCrowdingToTarget = (position: GridPosition): number => {
    const key = positionKey(position);
    const cached = crowdingCost.get(key);
    if (cached !== undefined) return cached;
    const distance = distanceToTarget.get(key);
    if (distance === undefined) return Number.POSITIVE_INFINITY;

    const localCrowding = occupancy.get(key) ?? 0;
    if (distance === 0) {
      crowdingCost.set(key, localCrowding);
      return localCrowding;
    }

    let downstream = Number.POSITIVE_INFINITY;
    for (const delta of NEIGHBORS) {
      const next = { x: position.x + delta.x, y: position.y + delta.y };
      if (distanceToTarget.get(positionKey(next)) !== distance - 1) continue;
      downstream = Math.min(downstream, minimumCrowdingToTarget(next));
    }
    const total = localCrowding + downstream;
    crowdingCost.set(key, total);
    return total;
  };

  let bestStep = start;
  let bestCrowding = Number.POSITIVE_INFINITY;
  for (const delta of NEIGHBORS) {
    const next = { x: start.x + delta.x, y: start.y + delta.y };
    if (distanceToTarget.get(positionKey(next)) !== startDistance - 1) continue;
    const crowding = minimumCrowdingToTarget(next);
    if (crowding < bestCrowding) {
      bestCrowding = crowding;
      bestStep = next;
    }
  }
  return bestStep;
}

function createCrowdFlow(state: Pick<WorldState, "agents">): CrowdFlow {
  // One living-BOT occupancy pass per tick, maintained as this tick's moves are
  // applied so every departure check sees the movers that already left.
  const occupancy = new Map<string, number>();
  for (const agent of state.agents) {
    if (agent.hp <= 0) continue;
    incrementCongestion(occupancy, positionKey(agent.position));
  }
  return { occupancy, departures: new Map<string, number>() };
}

function crowdedDepartureBlocked(flow: CrowdFlow, agent: Agent): boolean {
  if ((flow.occupancy.get(positionKey(agent.position)) ?? 0) < MOVE_CROWDING_THRESHOLD) {
    return false;
  }
  return (flow.departures.get(positionKey(agent.position)) ?? 0) >= MOVE_CROWDED_DEPARTURES_PER_TICK;
}

function moveAgent(state: WorldState, agent: Agent, target: GridPosition, flow?: CrowdFlow): boolean {
  if (samePosition(agent.position, target)) return true;
  const originKey = positionKey(agent.position);
  if (flow !== undefined && crowdedDepartureBlocked(flow, agent)) {
    // Crowding costs ticks instead of energy: the queued BOT keeps its intent,
    // spends nothing, and leaves on a later tick once the hex drains.
    agent.status = "waiting in crowd";
    return false;
  }
  const next = nextStepTowards(state, agent.position, target, flow);
  if (samePosition(next, agent.position)) {
    agent.status = "path blocked";
    return false;
  }
  if (flow !== undefined) {
    incrementCongestion(flow.departures, originKey);
    const remaining = (flow.occupancy.get(originKey) ?? 1) - 1;
    if (remaining > 0) flow.occupancy.set(originKey, remaining);
    else flow.occupancy.delete(originKey);
    incrementCongestion(flow.occupancy, positionKey(next));
  }
  agent.position = next;
  agent.energy = Math.max(0, agent.energy - 1);
  agent.status = `moving to ${target.x},${target.y}`;
  addEvent(state, {
    kind: "agent_moved",
    message: `${agent.name} moved to ${next.x},${next.y}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...next },
  });
  return samePosition(next, target);
}

function incrementCongestion(index: Map<string, number>, key: string): void {
  index.set(key, (index.get(key) ?? 0) + 1);
}

function resourceCongestionIndex(
  state: Pick<WorldState, "agents">,
  resource: ResourceKind,
): Map<string, number> {
  const index = new Map<string, number>();
  for (const agent of state.agents) {
    if (agent.hp <= 0) continue;
    const keys = new Set<string>([positionKey(agent.position)]);
    if (
      agent.task?.type === "gather" &&
      agent.task.resource === resource &&
      agent.task.target !== undefined
    ) {
      keys.add(positionKey(agent.task.target));
    }
    for (const key of keys) incrementCongestion(index, key);
  }
  return index;
}

function depositCongestionIndex(
  state: Pick<WorldState, "agents">,
  structures: readonly Structure[],
): Map<string, number> {
  const index = new Map<string, number>(structures.map((structure) => [structure.id, 0]));
  const idsByPosition = new Map<string, string[]>();
  for (const structure of structures) {
    const key = positionKey(structure.position);
    const ids = idsByPosition.get(key);
    if (ids === undefined) idsByPosition.set(key, [structure.id]);
    else ids.push(structure.id);
  }
  for (const agent of state.agents) {
    if (agent.hp <= 0) continue;
    const affected = new Set(idsByPosition.get(positionKey(agent.position)) ?? []);
    if (
      agent.task?.type === "deposit" &&
      agent.task.structureId !== undefined &&
      index.has(agent.task.structureId)
    ) {
      affected.add(agent.task.structureId);
    }
    for (const structureId of affected) incrementCongestion(index, structureId);
  }
  return index;
}

function buildCongestionIndex(state: Pick<WorldState, "agents">): Map<string, number> {
  const index = new Map<string, number>();
  for (const agent of state.agents) {
    if (agent.hp <= 0) continue;
    const keys = new Set<string>([positionKey(agent.position)]);
    if (agent.task?.type === "build" && agent.task.target !== undefined) {
      keys.add(positionKey(agent.task.target));
    }
    for (const key of keys) incrementCongestion(index, key);
  }
  return index;
}

function storageCapacityLeft(structure: Structure): number {
  return Math.max(
    0,
    BUILD_RECIPES[structure.type].storageCapacity - inventoryTotal(structure.storage),
  );
}

function nearestDepositStructure(
  state: WorldState,
  factionId: string,
  position: GridPosition,
): Structure | undefined {
  const candidates = activeFactionStructures(state, factionId)
    .filter((structure) => storageCapacityLeft(structure) > 0);
  const congestion = depositCongestionIndex(state, candidates);
  return candidates
    .sort((a, b) => {
      const distance = manhattanDistance(a.position, position) - manhattanDistance(b.position, position);
      if (distance !== 0) return distance;
      const congestionDifference = (congestion.get(a.id) ?? 0) - (congestion.get(b.id) ?? 0);
      return congestionDifference || a.id.localeCompare(b.id);
    })[0];
}

function nearestResource(
  state: WorldState,
  origin: GridPosition,
  resource: ResourceKind,
): GridPosition | undefined {
  const candidates = state.tiles.filter((candidate) =>
    candidate.resource?.kind === resource &&
    candidate.resource.amount > 0 &&
    candidate.terrain !== "water"
  );
  const congestion = resourceCongestionIndex(state, resource);
  const tile = candidates
    .sort((a, b) => {
      const distance = manhattanDistance(a, origin) - manhattanDistance(b, origin);
      if (distance !== 0) return distance;
      const congestionDifference =
        (congestion.get(positionKey(a)) ?? 0) - (congestion.get(positionKey(b)) ?? 0);
      return congestionDifference || a.y - b.y || a.x - b.x;
    })[0];
  return tile === undefined ? undefined : { x: tile.x, y: tile.y };
}

function structureAccessCells(
  state: Pick<WorldState, "width" | "height" | "tiles" | "structures">,
  structurePosition: GridPosition,
  blockedPosition?: GridPosition,
): GridPosition[] {
  return NEIGHBORS
    .map((step) => ({ x: structurePosition.x + step.x, y: structurePosition.y + step.y }))
    .filter((candidate) => inBounds(state, candidate) && isPassable(state, candidate))
    .filter((candidate) => blockedPosition === undefined || !samePosition(candidate, blockedPosition))
    .filter((candidate) =>
      !state.structures.some((structure) => samePosition(structure.position, candidate))
    );
}

function hasUsableStructureAccess(
  state: Pick<WorldState, "width" | "height" | "tiles" | "structures">,
  structurePosition: GridPosition,
  blockedPosition?: GridPosition,
): boolean {
  return structureAccessCells(state, structurePosition, blockedPosition).some((accessCell) =>
    NEIGHBORS.some((step) => {
      const next = { x: accessCell.x + step.x, y: accessCell.y + step.y };
      if (samePosition(next, structurePosition)) return false;
      if (blockedPosition !== undefined && samePosition(next, blockedPosition)) return false;
      if (!inBounds(state, next) || !isPassable(state, next)) return false;
      return !state.structures.some((structure) => samePosition(structure.position, next));
    })
  );
}

function buildSitePreservesStructureAccess(state: WorldState, position: GridPosition): boolean {
  if (!inBounds(state, position) || !isPassable(state, position)) return false;
  if (state.structures.some((structure) => samePosition(structure.position, position))) return false;

  // Dense blocks are allowed, but every new footprint needs at least one
  // person-sized approach hex that itself connects onward to another open hex.
  // This prevents a decorative one-cell pocket from counting as an entrance.
  if (!hasUsableStructureAccess(state, position, position)) return false;

  // A new building may share an alley with its neighbors, but it must never
  // consume the last usable entrance / construction approach of an adjacent
  // existing building.
  return state.structures
    .filter((structure) => hexGridDistance(structure.position, position) === 1)
    .every((structure) => hasUsableStructureAccess(state, structure.position, position));
}

function findBuildSite(
  state: WorldState,
  origin: GridPosition,
  factionId: string,
  minCampSpacing = 0,
): GridPosition | undefined {
  const occupied = new Set(state.structures.map((structure) => `${structure.position.x},${structure.position.y}`));
  const activeCampPositions = minCampSpacing > 0
    ? activeFactionStructures(state, factionId)
      .filter((structure) => structure.type === "camp")
      .map((structure) => structure.position)
    : [];
  const candidates = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .filter((tile) => buildSitePreservesStructureAccess(state, tile))
    .filter((tile) => manhattanDistance(tile, origin) <= 5)
    .filter((tile) =>
      activeCampPositions.every((campPosition) =>
        manhattanDistance(tile, campPosition) >= minCampSpacing
      )
    );
  const congestion = buildCongestionIndex(state);
  candidates.sort((a, b) => {
    const resourcePenaltyA = a.resource === undefined ? 0 : 1;
    const resourcePenaltyB = b.resource === undefined ? 0 : 1;
    return (
      resourcePenaltyA - resourcePenaltyB ||
      manhattanDistance(a, origin) - manhattanDistance(b, origin) ||
      (congestion.get(positionKey(a)) ?? 0) - (congestion.get(positionKey(b)) ?? 0) ||
      a.y - b.y ||
      a.x - b.x
    );
  });

  const ownPositions = new Set(
    state.agents.filter((agent) => agent.factionId === factionId).map((agent) => `${agent.position.x},${agent.position.y}`),
  );
  const candidate =
    candidates.find((entry) => !ownPositions.has(`${entry.x},${entry.y}`)) ?? candidates[0];
  return candidate === undefined ? undefined : { x: candidate.x, y: candidate.y };
}

function autonomyTask(state: WorldState, agent: Agent): AgentTask | undefined {
  const issuedAtTick = state.tick;
  const base = { source: "autonomy" as const, issuedAtTick };
  const structures = activeFactionStructures(state, agent.factionId);
  const inventoryAmount = inventoryTotal(agent.inventory);
  const hasAvailableStorage = structures.some((structure) => storageCapacityLeft(structure) > 0);

  if (
    structures.length > 0 &&
    hasAvailableStorage &&
    inventoryAmount >= Math.min(6, agent.capacity)
  ) {
    return { ...base, type: "deposit" };
  }

  if (agent.role === "builder") {
    const camps = state.structures
      .filter((structure) => structure.factionId === agent.factionId && structure.type === "camp")
      .sort((a, b) => a.id.localeCompare(b.id));
    const buildingCamp = camps.find((structure) => structure.status === "building");
    const activeCamps = camps.filter((structure) => structure.status === "active");
    const camp = activeCamps[0];
    if (camp === undefined) {
      if (buildingCamp !== undefined) {
        return {
          ...base,
          type: "build",
          structureType: "camp",
          target: buildingCamp.position,
          structureId: buildingCamp.id,
        };
      }
      const recipe = BUILD_RECIPES.camp;
      if (hasInventory(agent.inventory, recipe.cost)) {
        const target = findBuildSite(state, agent.position, agent.factionId) ?? agent.position;
        return { ...base, type: "build", structureType: "camp", target };
      }
      const resource = inventoryMissingForRecipe(agent.inventory, "camp");
      const target = nearestResource(state, agent.position, resource);
      return target === undefined
        ? undefined
        : { ...base, type: "gather", resource, target };
    }
    if (buildingCamp !== undefined) {
      return {
        ...base,
        type: "build",
        structureType: "camp",
        target: buildingCamp.position,
        structureId: buildingCamp.id,
      };
    }

    const buildOrder: readonly StructureType[] = ["storehouse", "market", "workshop"];
    for (const type of buildOrder) {
      const existing = state.structures.find(
        (structure) => structure.factionId === agent.factionId && structure.type === type,
      );
      if (existing?.status === "building") {
        return {
          ...base,
          type: "build",
          structureType: type,
          target: existing.position,
          structureId: existing.id,
        };
      }
      if (existing === undefined) {
        if (factionCanAfford(state, agent.factionId, BUILD_RECIPES[type].cost)) {
          const target = findBuildSite(state, camp.position, agent.factionId);
          if (target !== undefined) return { ...base, type: "build", structureType: type, target };
        }
        if (inventoryAmount > 0 && hasAvailableStorage) return { ...base, type: "deposit" };
        const resource = factionMissingForRecipe(state, agent.factionId, type);
        const target = nearestResource(state, agent.position, resource);
        return target === undefined
          ? undefined
          : { ...base, type: "gather", resource, target };
      }
    }

    const population = state.agents.filter((candidate) =>
      candidate.factionId === agent.factionId && candidate.hp > 0
    ).length;
    const residentCapacity = activeCamps.length * SETTLEMENT_RESIDENT_CAPACITY_PER_CAMP;
    if (population >= residentCapacity) {
      const campBuildReserved = state.agents.some(
        (candidate) =>
          candidate.id !== agent.id &&
          candidate.factionId === agent.factionId &&
          candidate.task?.type === "build" &&
          candidate.task.structureType === "camp",
      );
      if (campBuildReserved) return undefined;

      if (factionCanAfford(state, agent.factionId, BUILD_RECIPES.camp.cost)) {
        // Housing pressure may expand the local settlement only while a genuinely
        // spaced camp site remains. Once that local geometry is exhausted, leave
        // the builder available for the region-level settlement migration planner
        // instead of packing another camp into the inner ring and erasing the
        // demographic pressure that should produce a new settlement.
        const target = findBuildSite(
          state,
          camp.position,
          agent.factionId,
          SETTLEMENT_CAMP_MIN_SPACING,
        );
        if (target !== undefined) return { ...base, type: "build", structureType: "camp", target };
        return undefined;
      }
      if (inventoryAmount > 0 && hasAvailableStorage) return { ...base, type: "deposit" };
      const resource = factionMissingForRecipe(state, agent.factionId, "camp");
      const target = nearestResource(state, agent.position, resource);
      return target === undefined
        ? undefined
        : { ...base, type: "gather", resource, target };
    }
  }

  const resource: ResourceKind =
    agent.role === "woodcutter" ? "wood" : agent.role === "miner" ? "stone" : "food";
  const target = nearestResource(state, agent.position, resource);
  if (target !== undefined) return { ...base, type: "gather", resource, target };

  const fallback = state.tiles
    .filter((tile) => tile.terrain !== "water")
    .sort((a, b) => manhattanDistance(a, agent.position) - manhattanDistance(b, agent.position))[0];
  return fallback === undefined
    ? undefined
    : { ...base, type: "move", target: { x: fallback.x, y: fallback.y } };
}

function localAgentCrowding(
  state: Pick<WorldState, "agents">,
  position: GridPosition,
): number {
  return state.agents.reduce(
    (count, candidate) => count + (
      candidate.hp > 0 && samePosition(candidate.position, position) ? 1 : 0
    ),
    0,
  );
}

function gatherAmountAtCrowding(crowding: number): number {
  return crowding >= GATHER_CROWDING_THRESHOLD
    ? GATHER_CROWDED_AMOUNT
    : GATHER_BASE_AMOUNT;
}

function depositThroughputAtCrowding(crowding: number, availableCapacity: number): number {
  return crowding >= DEPOSIT_CROWDING_THRESHOLD
    ? Math.min(availableCapacity, DEPOSIT_CROWDED_THROUGHPUT)
    : availableCapacity;
}

function rebalanceAutonomousGatherTarget(
  state: WorldState,
  agent: Agent,
  task: Extract<AgentTask, { type: "gather" }>,
  target: GridPosition,
): GridPosition {
  if (!agent.autonomy || task.source !== "autonomy" || samePosition(agent.position, target)) return target;
  const congestion = resourceCongestionIndex(state, task.resource);
  if ((congestion.get(positionKey(target)) ?? 0) < GATHER_CROWDING_THRESHOLD) return target;

  const candidate = nearestResource(state, agent.position, task.resource);
  if (
    candidate === undefined ||
    samePosition(candidate, target) ||
    manhattanDistance(candidate, agent.position) > manhattanDistance(target, agent.position)
  ) {
    return target;
  }
  return candidate;
}

function rebalanceAutonomousDepositTarget(
  state: WorldState,
  agent: Agent,
  task: Extract<AgentTask, { type: "deposit" }>,
  structure: Structure,
): Structure {
  if (!agent.autonomy || task.source !== "autonomy" || samePosition(agent.position, structure.position)) {
    return structure;
  }
  const candidates = activeFactionStructures(state, agent.factionId)
    .filter((candidate) => storageCapacityLeft(candidate) > 0);
  const congestion = depositCongestionIndex(state, candidates);
  if ((congestion.get(structure.id) ?? 0) < DEPOSIT_CROWDING_THRESHOLD) return structure;

  const candidate = nearestDepositStructure(state, agent.factionId, agent.position);
  if (
    candidate === undefined ||
    candidate.id === structure.id ||
    manhattanDistance(candidate.position, agent.position) >
      manhattanDistance(structure.position, agent.position)
  ) {
    return structure;
  }
  return candidate;
}

function executeGather(
  state: WorldState,
  agent: Agent,
  task: Extract<AgentTask, { type: "gather" }>,
  flow: CrowdFlow,
): void {
  if (inventoryTotal(agent.inventory) >= agent.capacity) {
    delete agent.task;
    agent.status = "inventory full";
    return;
  }
  let target = task.target;
  const targetTile = target === undefined ? undefined : getTile(state, target);
  if (
    target === undefined ||
    targetTile?.resource?.kind !== task.resource ||
    targetTile.resource.amount <= 0
  ) {
    target = nearestResource(state, agent.position, task.resource);
    if (target === undefined) {
      delete agent.task;
      agent.status = `no ${task.resource} known`;
      return;
    }
    task.target = target;
  }

  if (!samePosition(agent.position, target)) {
    const rebalancedTarget = rebalanceAutonomousGatherTarget(state, agent, task, target);
    if (!samePosition(rebalancedTarget, target)) {
      target = rebalancedTarget;
      task.target = rebalancedTarget;
    }
    moveAgent(state, agent, target, flow);
    return;
  }

  const tile = getTile(state, agent.position);
  if (tile?.resource?.kind !== task.resource || tile.resource.amount <= 0) {
    delete agent.task;
    agent.status = `${task.resource} depleted`;
    return;
  }
  const capacityLeft = agent.capacity - inventoryTotal(agent.inventory);
  const crowding = localAgentCrowding(state, agent.position);
  const amount = Math.min(
    gatherAmountAtCrowding(crowding),
    tile.resource.amount,
    capacityLeft,
  );
  tile.resource.amount -= amount;
  agent.inventory[task.resource] += amount;
  agent.energy = Math.max(0, agent.energy - 1);
  agent.status = `gathering ${task.resource}`;
  addEvent(state, {
    kind: "resource_gathered",
    message: `${agent.name} gathered ${amount} ${task.resource}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { resource: task.resource, amount },
  });

  const hasCamp = state.structures.some(
    (structure) => structure.factionId === agent.factionId && structure.type === "camp",
  );
  if (
    agent.role === "builder" &&
    !hasCamp &&
    agent.inventory[task.resource] >= BUILD_RECIPES.camp.cost[task.resource]
  ) {
    delete agent.task;
    agent.status = `${task.resource} secured for founding camp`;
  }

  if (tile.resource.amount === 0) {
    addEvent(state, {
      kind: "resource_depleted",
      message: `${task.resource} at ${tile.x},${tile.y} was depleted.`,
      position: { x: tile.x, y: tile.y },
      data: { resource: task.resource },
    });
    delete agent.task;
  }
}

function executeDeposit(
  state: WorldState,
  agent: Agent,
  task: Extract<AgentTask, { type: "deposit" }>,
  flow: CrowdFlow,
): void {
  let structure = task.structureId === undefined ? undefined : getStructure(state, task.structureId);
  if (
    structure === undefined ||
    structure.factionId !== agent.factionId ||
    structure.status !== "active" ||
    storageCapacityLeft(structure) <= 0
  ) {
    structure = nearestDepositStructure(state, agent.factionId, agent.position);
  }
  if (structure === undefined) {
    delete agent.task;
    agent.status = "no storage available";
    return;
  }
  structure = rebalanceAutonomousDepositTarget(state, agent, task, structure);
  task.structureId = structure.id;
  if (!samePosition(agent.position, structure.position)) {
    moveAgent(state, agent, structure.position, flow);
    return;
  }

  const faction = getFaction(state, agent.factionId);
  if (faction === undefined) {
    delete agent.task;
    return;
  }
  const deposited = emptyInventory();
  const crowding = localAgentCrowding(state, structure.position);
  let remainingCapacity = depositThroughputAtCrowding(
    crowding,
    storageCapacityLeft(structure),
  );
  for (const kind of RESOURCE_KINDS) {
    const amount = Math.min(agent.inventory[kind], remainingCapacity);
    if (amount <= 0) continue;
    faction.resources[kind] += amount;
    structure.storage[kind] += amount;
    agent.inventory[kind] -= amount;
    deposited[kind] = amount;
    remainingCapacity -= amount;
  }

  const depositedTotal = inventoryTotal(deposited);
  const remainingInventory = inventoryTotal(agent.inventory);
  if (remainingInventory === 0) {
    delete agent.task;
    agent.status = "resources deposited";
  } else {
    delete task.structureId;
    agent.status = `${remainingInventory} resources await storage`;
  }
  if (depositedTotal <= 0) return;
  addEvent(state, {
    kind: "resources_deposited",
    message: `${agent.name} deposited ${depositedTotal} resources at ${structure.type}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { deposited },
  });
}

function resolveBuildTaskTarget(
  state: WorldState,
  agent: Agent,
  task: BuildTask,
): GridPosition | undefined {
  if (task.structureId !== undefined) {
    const structure = getStructure(state, task.structureId);
    if (
      structure !== undefined &&
      structure.factionId === agent.factionId &&
      structure.type === task.structureType
    ) {
      task.target = { ...structure.position };
      return task.target;
    }
    delete task.structureId;
  }

  if (task.target !== undefined && isPassable(state, task.target)) return task.target;
  delete task.target;

  const existingBuilding = state.structures.find(
    (structure) =>
      structure.factionId === agent.factionId &&
      structure.type === task.structureType &&
      structure.status === "building",
  );
  if (existingBuilding !== undefined) {
    task.structureId = existingBuilding.id;
    task.target = { ...existingBuilding.position };
    return task.target;
  }
  const activeAlreadyAvailable = state.structures.some(
    (structure) =>
      structure.factionId === agent.factionId &&
      structure.type === task.structureType &&
      structure.status === "active",
  );
  if (activeAlreadyAvailable && task.structureType !== "camp") {
    delete agent.task;
    agent.status = `${task.structureType} already available`;
    return undefined;
  }

  const camp = activeFactionStructures(state, agent.factionId).find(
    (structure) => structure.type === "camp",
  );
  const target = findBuildSite(state, camp?.position ?? agent.position, agent.factionId);
  if (target === undefined) {
    delete agent.task;
    agent.status = `no local site for ${task.structureType}`;
    return undefined;
  }
  task.target = target;
  return target;
}

function startConstruction(
  state: WorldState,
  agent: Agent,
  task: BuildTask,
  target: GridPosition,
): Structure | undefined {
  if (state.structures.some((structure) => samePosition(structure.position, target))) {
    agent.status = "build site occupied";
    delete agent.task;
    return undefined;
  }
  if (!buildSitePreservesStructureAccess(state, target)) {
    agent.status = "build site lacks structure access";
    delete agent.task;
    return undefined;
  }
  const recipe = BUILD_RECIPES[task.structureType];
  const activeStructures = activeFactionStructures(state, agent.factionId);
  // A pioneer camp kit has already been removed from the source region's
  // physical storage and faction ledger before ownership handoff. If the
  // destination happens to contain another same-faction active structure
  // (for example a storehouse without a camp), the carried kit must still
  // pay for the frontier camp rather than charging destination stock again.
  const carriedPioneerCampKit =
    task.structureType === "camp"
    && agent.settlementMigrationOriginRegionId !== undefined
    && agent.settlementMigrationOriginRegionId !== state.regionId
    && hasInventory(agent.inventory, recipe.cost);
  const paid = carriedPioneerCampKit || (
    activeStructures.length === 0
      ? hasInventory(agent.inventory, recipe.cost)
      : factionCanAfford(state, agent.factionId, recipe.cost)
  );
  if (!paid) {
    agent.status = `missing materials for ${task.structureType}`;
    delete agent.task;
    return undefined;
  }
  if (carriedPioneerCampKit || activeStructures.length === 0) {
    consumeInventory(agent.inventory, recipe.cost);
  } else {
    consumeFactionResources(state, agent.factionId, recipe.cost);
  }

  const structure: Structure = {
    id: `structure-${agent.factionId}-${task.structureType}-${state.tick}-${state.structures.length + 1}`,
    factionId: agent.factionId,
    type: task.structureType,
    position: { ...target },
    status: "building",
    progress: 0,
    requiredProgress: recipe.work,
    storage: emptyInventory(),
  };
  state.structures.push(structure);
  task.structureId = structure.id;
  addEvent(state, {
    kind: "construction_started",
    message: `${agent.name} started a ${task.structureType}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...target },
    data: { structureId: structure.id, structureType: task.structureType },
  });
  return structure;
}

function executeBuild(
  state: WorldState,
  agent: Agent,
  task: BuildTask,
  flow: CrowdFlow,
  absorbedConstructionWork: Map<string, number>,
): void {
  const target = resolveBuildTaskTarget(state, agent, task);
  if (target === undefined) return;
  if (!samePosition(agent.position, target)) {
    moveAgent(state, agent, target, flow);
    return;
  }
  let structure = task.structureId === undefined ? undefined : getStructure(state, task.structureId);
  if (structure === undefined) structure = startConstruction(state, agent, task, target);
  if (structure === undefined) return;
  if (structure.status === "active") {
    delete agent.task;
    agent.status = `${structure.type} complete`;
    return;
  }

  // A building type can only absorb so much construction work per tick. Once a
  // structure of this type has taken its work capacity, extra builders already
  // standing on the same hex wait for the next tick instead of advancing it in
  // parallel, paying neither materials nor energy for work the site cannot use.
  const absorbedWork = absorbedConstructionWork.get(structure.id) ?? 0;
  if (absorbedWork >= BUILD_RECIPES[structure.type].workCapacity) {
    agent.status = `waiting for ${structure.type} work capacity`;
    return;
  }
  absorbedConstructionWork.set(structure.id, absorbedWork + 1);

  structure.progress += 1;
  agent.energy = Math.max(0, agent.energy - 2);
  agent.status = `building ${structure.type} ${structure.progress}/${structure.requiredProgress}`;
  if (structure.progress >= structure.requiredProgress) {
    structure.status = "active";
    structure.progress = structure.requiredProgress;
    delete agent.task;
    agent.status = `${structure.type} completed`;
    addEvent(state, {
      kind: "construction_completed",
      message: `${agent.name} completed a ${structure.type} for ${agent.factionId}.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...structure.position },
      data: { structureId: structure.id, structureType: structure.type },
    });
  } else if (structure.progress === 1 || structure.progress % 4 === 0) {
    addEvent(state, {
      kind: "construction_progress",
      message: `${structure.type} construction reached ${structure.progress}/${structure.requiredProgress}.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...structure.position },
      data: { structureId: structure.id, progress: structure.progress },
    });
  }
}

function canTransfer(agent: Agent, inventory: Inventory): boolean {
  return RESOURCE_KINDS.every((kind) => agent.inventory[kind] >= inventory[kind]);
}

function executeTrade(
  state: WorldState,
  agent: Agent,
  task: Extract<AgentTask, { type: "trade" }>,
  flow: CrowdFlow,
): void {
  const target = getAgent(state, task.targetAgentId);
  if (target === undefined) {
    const remoteTradeAlive =
      task.source === "autonomy"
      && task.targetAgentId.startsWith("agent-global:")
      && state.tick - task.issuedAtTick <= AUTONOMOUS_REMOTE_TRADE_TTL;
    if (remoteTradeAlive && task.routeTarget !== undefined) {
      // Once the autonomy layer has located an immediate-neighbor owner, keep
      // ordinary movement inside simulation. The hint is source-local and is
      // revalidated at the seam before ownership handoff.
      if (!samePosition(agent.position, task.routeTarget)) {
        moveAgent(state, agent, task.routeTarget, flow);
      } else {
        agent.status = `waiting to cross region for trade with ${task.targetAgentId}`;
      }
      return;
    }
    if (remoteTradeAlive) {
      // A counterparty can leave this Region DO between planning and execution.
      // Keep the world-global promise alive long enough for the cross-region
      // autonomy layer to discover its new owner instead of deleting it in the
      // same tick as ownership handoff. The bounded virtual-tick TTL prevents a
      // permanently vanished counterparty from pinning the trader forever.
      agent.status = `locating trade counterparty ${task.targetAgentId}`;
      return;
    }
    delete agent.task;
    agent.status = task.source === "autonomy" && task.targetAgentId.startsWith("agent-global:")
      ? "remote trade target lookup expired"
      : "trade target disappeared";
    return;
  }
  delete task.routeRegionId;
  delete task.routeTarget;
  if (!samePosition(agent.position, target.position)) {
    moveAgent(state, agent, target.position, flow);
    return;
  }
  if (!canTransfer(agent, task.offer) || !canTransfer(target, task.request)) {
    addEvent(state, {
      kind: "trade_failed",
      message: `${agent.name} and ${target.name} could not satisfy the proposed trade.`,
      agentId: agent.id,
      factionId: agent.factionId,
      position: { ...agent.position },
      data: { targetAgentId: target.id },
    });
    delete agent.task;
    agent.status = "trade failed";
    return;
  }
  for (const kind of RESOURCE_KINDS) {
    agent.inventory[kind] -= task.offer[kind];
    target.inventory[kind] += task.offer[kind];
    target.inventory[kind] -= task.request[kind];
    agent.inventory[kind] += task.request[kind];
  }
  delete agent.task;
  agent.status = `traded with ${target.name}`;
  addEvent(state, {
    kind: "trade_completed",
    message: `${agent.name} traded resources with ${target.name}.`,
    agentId: agent.id,
    factionId: agent.factionId,
    position: { ...agent.position },
    data: { targetAgentId: target.id, offer: task.offer, request: task.request },
  });
}

function executeTask(
  state: WorldState,
  agent: Agent,
  flow: CrowdFlow,
  absorbedConstructionWork: Map<string, number>,
): void {
  const task = agent.task;
  if (task === undefined) {
    agent.status = agent.autonomy ? "replanning" : "awaiting external command";
    agent.energy = Math.min(100, agent.energy + 1);
    return;
  }
  if (task.expiresAtTick !== undefined && state.tick > task.expiresAtTick) {
    delete agent.task;
    agent.status = "external task expired";
    return;
  }

  switch (task.type) {
    case "move":
      if (moveAgent(state, agent, task.target, flow)) {
        delete agent.task;
        agent.status = "destination reached";
      }
      break;
    case "gather":
      executeGather(state, agent, task, flow);
      break;
    case "build":
      executeBuild(state, agent, task, flow, absorbedConstructionWork);
      break;
    case "deposit":
      executeDeposit(state, agent, task, flow);
      break;
    case "trade":
      executeTrade(state, agent, task, flow);
      break;
  }
}

function regrowResources(state: WorldState, random: ReturnType<typeof createRandom>): void {
  for (const tile of state.tiles) {
    if (tile.resource === undefined || tile.resource.amount >= tile.resource.maxAmount) continue;
    if (random.next() < resourceRegrowthChance(state, tile)) tile.resource.amount += 1;
  }
}

export function simulate(
  previousState: WorldState,
  commands: readonly WorldCommand[] = [],
  config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
): SimulationResult {
  const state = structuredClone(previousState);
  migrateWorldToHexGrid(state);
  ensureTileElevations(state);
  ensureTileTerrainLayers(state);
  updateTileHydrology(state);
  state.tick += 1;
  state.revision += 1;
  const random = createRandom(state.rngState);

  const receipts = commands.map((command) => applyCommand(state, command, config));

  const demographicRecovery = demographicWorkRecoveryReasons(state);
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  // One departure budget per tick, shared by every task kind, so a crowded hex
  // cannot be drained faster by switching between gather / deposit / trade.
  const flow = createCrowdFlow(state);
  // Construction work absorbed per structure in this tick, reset every tick.
  // Transient simulation bookkeeping only: it is never persisted into WorldState.
  const absorbedConstructionWork = new Map<string, number>();
  for (const agent of agents) {
    const recoveryReason = demographicRecovery.get(agent.id);
    if (recoveryReason !== undefined) {
      // Preserve the existing autonomous task as intent, but spend this tick
      // recovering instead of moving/gathering/building/trading. Once energy is
      // above the demographic reserve threshold the same task can resume.
      agent.energy = Math.min(100, agent.energy + 1);
      agent.status = recoveryReason === "pregnancy"
        ? "resting during pregnancy"
        : "resting after dependent care";
      continue;
    }
    if (agent.task === undefined && agent.autonomy) {
      const plannedTask = autonomyTask(state, agent);
      if (plannedTask !== undefined) agent.task = plannedTask;
    }
    executeTask(state, agent, flow, absorbedConstructionWork);
  }

  if (state.tick % TERRAIN_EVOLUTION_INTERVAL === 0) {
    if (state.tick % UPLIFT_INTERVAL === 0) {
      applyTerrainUplift(state, config.upliftRateAt ?? upliftRateAt);
    }
    updateTileHydrology(state);
    applyTerrainErosion(state);
    applyMassWasting(state);
    updateTileHydrology(state);
  }
  if (state.tick % config.resourceRegrowthInterval === 0) regrowResources(state, random);
  state.rngState = random.state();
  state.events = state.events.slice(-config.eventLimit);
  state.processedCommandIds = state.processedCommandIds.slice(-config.commandHistoryLimit);
  return { state, receipts };
}
