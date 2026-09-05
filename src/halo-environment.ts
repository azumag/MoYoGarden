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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tileElevation(tile: Tile | undefined): number | undefined {
  const elevation = tile?.elevation;
  return Number.isFinite(elevation ?? Number.NaN) ? elevation : undefined;
}

function haloNeighborWaterInfluence(
  position: GridPosition,
  halo: readonly HexHaloTile[],
): number {
  const lookup = hexHaloLookup(halo);
  for (const direction of HEX_GRID_DIRECTIONS) {
    const ghost = lookup.get(hexHaloKey(position, direction));
    if (ghost?.tile.terrain === "water") return 1;
  }
  return 0;
}

function haloNeighborPropaguleInfluence(
  position: GridPosition,
  resourceKind: Exclude<ResourceKind, "stone">,
  halo: readonly HexHaloTile[],
): number {
  const lookup = hexHaloLookup(halo);
  let influence = 0;
  for (const direction of HEX_GRID_DIRECTIONS) {
    const resource = lookup.get(hexHaloKey(position, direction))?.tile.resource;
    if (resource?.kind !== resourceKind || resource.maxAmount <= 0) continue;
    influence = Math.max(influence, clamp01(resource.amount / resource.maxAmount));
  }
  return influence;
}

/**
 * Recover the first conservative piece of cross-region catchment continuity.
 * A ghost boundary tile with no local flowTo is a sink only because its region
 * could not see across the Durable Object boundary. If the paired local cell is
 * lower, treat the ghost tile's already-computed drainage as passive runoff
 * entering this cell. Ghost tiles that already drain locally are left alone so
 * we do not redirect or double-count an established local flow path.
 */
export function haloDrainageInflowAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): number {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (tile === undefined || tile.terrain === "water" || elevation === undefined) return 0;

  const lookup = hexHaloLookup(halo);
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
    inflow = Math.max(inflow, ghostDrainage * slope);
  }
  return inflow;
}

export function surfaceMoistureWithHaloAt(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
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

  waterInfluence = Math.max(waterInfluence, haloNeighborWaterInfluence(position, halo));
  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? tile.resource.amount / tile.resource.maxAmount
      : 0;
  const elevation = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation ?? 0.5 : 0.5;
  const lowlandRetention = (1 - elevation) * 0.09;
  const runoff = Math.max(drainageAt(state, position), haloDrainageInflowAt(state, position, halo));
  const runoffRetention = runoff * 0.14;
  return Math.min(
    1,
    0.04 + lowlandRetention + runoffRetention + waterInfluence * 0.64 + vegetationCover * 0.16,
  );
}

export function resourceRegrowthChanceWithHalo(
  state: WorldState,
  tile: Tile,
  halo: readonly HexHaloTile[] = [],
): number {
  if (tile.resource === undefined || tile.resource.kind === "stone") return 0.18;
  const moisture = surfaceMoistureWithHaloAt(state, tile, halo);
  const propaguleInfluence = haloNeighborPropaguleInfluence(tile, tile.resource.kind, halo);
  const propaguleBonus = propaguleInfluence * HALO_ORGANIC_PROPAGULE_BONUS[tile.resource.kind];
  return tile.resource.kind === "wood"
    ? Math.min(0.32, 0.08 + moisture * 0.22 + propaguleBonus)
    : Math.min(0.34, 0.06 + moisture * 0.26 + propaguleBonus);
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
    const haloChance = resourceRegrowthChanceWithHalo(after, tile, halo);
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