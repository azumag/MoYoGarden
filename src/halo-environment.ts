import { createRandom } from "./prng.js";
import {
  HEX_GRID_DIRECTIONS,
  type HexGridDirection,
} from "./hex-grid.js";
import { hexHaloKey, hexHaloLookup, type HexHaloTile } from "./hex-halo.js";
import { manhattanDistance, type GridPosition, type ResourceKind, type Tile, type WorldState } from "./protocol.js";
import { drainageAt, resourceRegrowthChance } from "./simulation.js";
import { getTile } from "./world.js";

const WATER_MOISTURE_RADIUS = 4;
const HALO_ORGANIC_PROPAGULE_BONUS: Readonly<Record<Exclude<ResourceKind, "stone">, number>> = {
  wood: 0.05,
  food: 0.04,
};
const HALO_HYDROLOGY_EPSILON = 1e-6;
const HALO_RUNOFF_SLOPE_SCALE = 0.18;

type HaloLookup = ReturnType<typeof hexHaloLookup>;

export interface HaloFlowOutlet {
  direction: HexGridDirection;
  neighborRegionId: string;
  neighborPosition: GridPosition;
  elevation: number;
  drop: number;
  slope: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tileElevation(tile: Tile | undefined): number | undefined {
  const elevation = tile?.elevation;
  return Number.isFinite(elevation ?? Number.NaN) ? elevation : undefined;
}

function haloNeighborWaterInfluence(
  position: GridPosition,
  lookup: HaloLookup,
): number {
  for (const direction of HEX_GRID_DIRECTIONS) {
    const ghost = lookup.get(hexHaloKey(position, direction));
    if (ghost?.tile.terrain === "water") return 1;
  }
  return 0;
}

function haloNeighborPropaguleInfluence(
  position: GridPosition,
  resourceKind: Exclude<ResourceKind, "stone">,
  lookup: HaloLookup,
): number {
  let influence = 0;
  for (const direction of HEX_GRID_DIRECTIONS) {
    const resource = lookup.get(hexHaloKey(position, direction))?.tile.resource;
    if (resource?.kind !== resourceKind || resource.maxAmount <= 0) continue;
    const cover = clamp01(resource.amount / resource.maxAmount);
    // Independent neighboring stands provide additional seed/propagule sources.
    // Combine them as a bounded union so extra directions matter without ever
    // exceeding the existing normalized influence scale.
    influence = 1 - (1 - influence) * (1 - cover);
  }
  return clamp01(influence);
}

/**
 * Resolve a read-only cross-region outlet for a local boundary sink.
 *
 * Local flowTo remains authoritative. Only a land tile that has no local target
 * may consider a lower ghost tile, so this cannot steal or rewrite an existing
 * in-region path. The strongest downhill ghost becomes a transient candidate;
 * no neighbor Durable Object state is mutated and no cross-DO ownership is
 * persisted yet.
 */
function haloFlowOutletFromLookup(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
): HaloFlowOutlet | undefined {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (
    tile === undefined ||
    tile.terrain === "water" ||
    tile.flowTo !== undefined ||
    elevation === undefined
  ) {
    return undefined;
  }

  let best: HaloFlowOutlet | undefined;
  for (const direction of HEX_GRID_DIRECTIONS) {
    const ghost = lookup.get(hexHaloKey(position, direction));
    if (ghost === undefined) continue;
    const ghostElevation = tileElevation(ghost.tile);
    if (ghostElevation === undefined) continue;
    const drop = elevation - ghostElevation;
    if (drop <= HALO_HYDROLOGY_EPSILON) continue;
    if (best !== undefined && drop <= best.drop + HALO_HYDROLOGY_EPSILON) continue;
    best = {
      direction,
      neighborRegionId: ghost.neighborRegionId,
      neighborPosition: { ...ghost.neighborPosition },
      elevation: ghostElevation,
      drop,
      slope: clamp01(drop / HALO_RUNOFF_SLOPE_SCALE),
    };
  }
  return best;
}

export function haloFlowOutletAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): HaloFlowOutlet | undefined {
  return haloFlowOutletFromLookup(state, position, hexHaloLookup(halo));
}

/**
 * Recover the first conservative piece of cross-region catchment continuity.
 * A ghost boundary tile with no local flowTo is a sink only because its region
 * could not see across the Durable Object boundary. If the paired local cell is
 * lower, treat the ghost tile's already-computed drainage as passive runoff
 * entering this cell. Ghost tiles that already drain locally are left alone so
 * we do not redirect or double-count an established local flow path.
 *
 * Multiple unresolved ghost sinks can meet the same corner/edge cell on a hex.
 * Their catchments are independent tributaries, so accumulate their slope-
 * weighted runoff instead of keeping only the strongest one. Drainage remains
 * normalized to [0,1], preserving the existing moisture scale.
 */
function haloDrainageInflowFromLookup(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
): number {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (tile === undefined || tile.terrain === "water" || elevation === undefined) return 0;

  let inflow = 0;
  for (const direction of HEX_GRID_DIRECTIONS) {
    const ghost = lookup.get(hexHaloKey(position, direction));
    if (ghost === undefined || ghost.tile.terrain === "water" || ghost.tile.flowTo !== undefined) {
      continue;
    }
    const ghostElevation = tileElevation(ghost.tile);
    const ghostDrainage = Number.isFinite(ghost.tile.drainage ?? Number.NaN)
      ? clamp01(ghost.tile.drainage ?? 0)
      : 0;
    if (
      ghostElevation === undefined ||
      ghostDrainage <= 0 ||
      ghostElevation - elevation <= HALO_HYDROLOGY_EPSILON
    ) {
      continue;
    }
    const slope = clamp01((ghostElevation - elevation) / HALO_RUNOFF_SLOPE_SCALE);
    inflow = clamp01(inflow + ghostDrainage * slope);
  }
  return inflow;
}

export function haloDrainageInflowAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): number {
  return haloDrainageInflowFromLookup(state, position, hexHaloLookup(halo));
}

function surfaceMoistureWithHaloLookup(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
): number {
  const tile = getTile(state, position);
  if (tile === undefined) return 0;
  if (tile.terrain === "water") return 1;

  let waterInfluence = 0;
  for (let dy = -WATER_MOISTURE_RADIUS; dy <= WATER_MOISTURE_RADIUS; dy += 1) {
    for (let dx = -WATER_MOISTURE_RADIUS; dx <= WATER_MOISTURE_RADIUS; dx += 1) {
      const distance = manhattanDistance({ x: 0, y: 0 }, { x: dx, y: dy });
      if (distance === 0 || distance > WATER_MOISTURE_RADIUS) continue;
      const neighbor = getTile(state, { x: position.x + dx, y: position.y + dy });
      if (neighbor?.terrain !== "water") continue;
      waterInfluence = Math.max(
        waterInfluence,
        (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
      );
    }
  }

  waterInfluence = Math.max(waterInfluence, haloNeighborWaterInfluence(position, lookup));
  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? tile.resource.amount / tile.resource.maxAmount
      : 0;
  const elevation = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation ?? 0.5 : 0.5;
  const lowlandRetention = (1 - elevation) * 0.09;
  // Local catchment and unresolved cross-region tributaries are distinct upstream
  // contributions. If this tile is only a local sink because the lower outlet
  // lives in the halo, let a slope-weighted share pass through instead of
  // retaining the entire catchment at the Durable Object boundary.
  const outlet = haloFlowOutletFromLookup(state, position, lookup);
  const runoff = clamp01(
    (drainageAt(state, position) + haloDrainageInflowFromLookup(state, position, lookup)) *
      (1 - (outlet?.slope ?? 0)),
  );
  const runoffRetention = runoff * 0.14;
  return Math.min(
    1,
    0.04 + lowlandRetention + runoffRetention + waterInfluence * 0.64 + vegetationCover * 0.16,
  );
}

export function surfaceMoistureWithHaloAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): number {
  return surfaceMoistureWithHaloLookup(state, position, hexHaloLookup(halo));
}

function resourceRegrowthChanceWithHaloLookup(
  state: WorldState,
  tile: Tile,
  lookup: HaloLookup,
): number {
  if (tile.resource === undefined || tile.resource.kind === "stone") return 0.18;
  const moisture = surfaceMoistureWithHaloLookup(state, tile, lookup);
  const propaguleInfluence = haloNeighborPropaguleInfluence(tile, tile.resource.kind, lookup);
  const propaguleBonus = propaguleInfluence * HALO_ORGANIC_PROPAGULE_BONUS[tile.resource.kind];
  return tile.resource.kind === "wood"
    ? Math.min(0.32, 0.08 + moisture * 0.22 + propaguleBonus)
    : Math.min(0.34, 0.06 + moisture * 0.26 + propaguleBonus);
}

export function resourceRegrowthChanceWithHalo(
  state: WorldState,
  tile: Tile,
  halo: readonly HexHaloTile[] = [],
): number {
  return resourceRegrowthChanceWithHaloLookup(state, tile, hexHaloLookup(halo));
}

/**
 * The core simulation has already performed its ordinary local regrowth draw.
 * If halo water or matching neighboring organic biomass raises p0 to p1, a
 * second draw with probability `(p1-p0)/(1-p0)` conditioned on the first draw
 * having failed produces the exact combined probability p1 without allowing
 * two growth increments in the same tick. The before/after snapshots tell us
 * whether the base draw already succeeded.
 */
export function applyHaloRegrowthCompensation(
  before: WorldState,
  after: WorldState,
  halo: readonly HexHaloTile[],
  interval = 30,
): number {
  if (interval <= 0 || after.tick === 0 || after.tick % interval !== 0 || halo.length === 0) {
    return 0;
  }

  const beforeTiles = new Map(before.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
  const lookup = hexHaloLookup(halo);
  const random = createRandom(after.rngState);
  let grown = 0;

  for (const tile of after.tiles) {
    if (
      tile.resource === undefined ||
      tile.resource.kind === "stone" ||
      tile.resource.amount >= tile.resource.maxAmount
    ) {
      continue;
    }
    const previous = beforeTiles.get(`${tile.x},${tile.y}`);
    if (
      previous?.resource?.kind !== tile.resource.kind ||
      previous.resource.amount !== tile.resource.amount
    ) {
      // The core simulation already grew or otherwise changed this resource.
      continue;
    }

    const localChance = resourceRegrowthChance(after, tile);
    const haloChance = resourceRegrowthChanceWithHaloLookup(after, tile, lookup);
    if (haloChance <= localChance) continue;
    const conditional = clamp01((haloChance - localChance) / Math.max(1e-9, 1 - localChance));
    if (random.next() < conditional) {
      tile.resource.amount += 1;
      grown += 1;
    }
  }

  after.rngState = random.state();
  return grown;
}

export function haloWaterDirectionsAt(
  position: GridPosition,
  halo: readonly HexHaloTile[],
): HexGridDirection[] {
  const lookup = hexHaloLookup(halo);
  return HEX_GRID_DIRECTIONS.filter(
    (direction) => lookup.get(hexHaloKey(position, direction))?.tile.terrain === "water",
  );
}
