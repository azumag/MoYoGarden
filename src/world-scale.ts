import type { Tile, WorldState } from "./protocol.js";
import { createRandom } from "./prng.js";

export const TARGET_WORLD_WIDTH = 40;
export const TARGET_WORLD_HEIGHT = 24;

export interface WorldCoordinateSpace {
  worldSeed?: number;
  originX?: number;
  originY?: number;
}

export interface RegionBoundaryEdges {
  west?: boolean;
  east?: boolean;
  north?: boolean;
  south?: boolean;
}

export interface WorldConditions {
  elevation: number;
  moisture: number;
  slope: number;
  convergence: number;
  wetness: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function seededUnit(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0xffff_ffff;
}

function coordinateSeed(seed: number, x: number, y: number): number {
  const xHash = Math.imul(x + 1, 0x9e3779b1);
  const yHash = Math.imul(y + 1, 0x85ebca6b);
  return (seed ^ xHash ^ yHash ^ 0x27d4eb2d) >>> 0;
}

function elevationAt(worldSeed: number, globalX: number, globalY: number): number {
  const x = globalX + 0.5;
  const y = globalY + 0.5;
  const phaseA = seededUnit(worldSeed, 0x41c64e6d) * Math.PI * 2;
  const phaseB = seededUnit(worldSeed, 0x9e3779b9) * Math.PI * 2;
  const phaseC = seededUnit(worldSeed, 0x7f4a7c15) * Math.PI * 2;
  const broad = (
    Math.sin((x / 28) * Math.PI * 2 + phaseA) +
    Math.cos((y / 24) * Math.PI * 2 + phaseB)
  ) * 0.5;
  const ridge = Math.sin((x / 19 + y / 23) * Math.PI * 2 + phaseC);
  const local = seededUnit(worldSeed, coordinateSeed(worldSeed, globalX, globalY)) - 0.5;
  return clamp01(0.46 + broad * 0.18 + ridge * 0.1 + local * 0.075);
}

/**
 * Low-level terrain conditions sampled from a shared world seed and absolute
 * grid coordinate. The periods are expressed in tiles rather than normalized
 * by the current extent, so growing or chunking the world never rescales the
 * underlying landform field.
 *
 * `slope`, `convergence` and `wetness` are derived from the same elevation and
 * moisture fields instead of from named biome categories. They are intentionally
 * reusable by vegetation, erosion, agriculture and future climate systems.
 */
export function sampleWorldConditions(
  worldSeed: number,
  globalX: number,
  globalY: number,
): WorldConditions {
  const x = globalX + 0.5;
  const y = globalY + 0.5;
  const phaseB = seededUnit(worldSeed, 0x9e3779b9) * Math.PI * 2;
  const elevation = elevationAt(worldSeed, globalX, globalY);
  const local = seededUnit(worldSeed, coordinateSeed(worldSeed, globalX, globalY)) - 0.5;
  const moistureWave = Math.cos((x / 34 - y / 29) * Math.PI * 2 + phaseB);
  const moisture = clamp01(
    0.43 + moistureWave * 0.17 + (1 - elevation) * 0.31 + local * 0.08,
  );

  const west = elevationAt(worldSeed, globalX - 1, globalY);
  const east = elevationAt(worldSeed, globalX + 1, globalY);
  const north = elevationAt(worldSeed, globalX, globalY - 1);
  const south = elevationAt(worldSeed, globalX, globalY + 1);
  const rawSlope = Math.hypot(east - west, south - north) * 0.5;
  const slope = clamp01(rawSlope / 0.16);
  const neighborMean = (west + east + north + south) * 0.25;
  const convergence = clamp01(0.5 + (neighborMean - elevation) * 6);
  const wetness = clamp01(
    moisture +
      (1 - elevation) * 0.08 +
      (convergence - 0.5) * 0.16 -
      slope * 0.12,
  );

  return { elevation, moisture, slope, convergence, wetness };
}

/**
 * Re-anchor only the edge band that actually touches another loaded region to
 * the shared absolute-coordinate elevation field. Terrain/resource ownership is
 * deliberately preserved so migrating a persisted region cannot strand an agent
 * on newly-created water or erase gathered resources. A smooth interior blend
 * prevents the migrated edge from becoming a new artificial ridge.
 */
export function alignRegionBoundaryElevations(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  worldSeed: number,
  originX: number,
  originY: number,
  edges: RegionBoundaryEdges,
  bandWidth = 4,
): number {
  const safeBand = Math.max(1, Math.min(Math.max(state.width, state.height), Math.floor(bandWidth)));
  let changed = 0;

  for (const tile of state.tiles) {
    if (tile.terrain === "water") continue;
    const edgeDistances: number[] = [];
    if (edges.west) edgeDistances.push(tile.x);
    if (edges.east) edgeDistances.push(state.width - 1 - tile.x);
    if (edges.north) edgeDistances.push(tile.y);
    if (edges.south) edgeDistances.push(state.height - 1 - tile.y);
    if (edgeDistances.length === 0) continue;

    const distance = Math.min(...edgeDistances);
    if (distance < 0 || distance >= safeBand) continue;

    const target = Math.max(
      0.03,
      sampleWorldConditions(worldSeed, originX + tile.x, originY + tile.y).elevation,
    );
    const current = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation ?? target : target;
    const normalized = safeBand <= 1 ? 0 : Math.min(1, distance / safeBand);
    const smooth = normalized * normalized * (3 - 2 * normalized);
    const weight = 1 - smooth;
    const elevation = current + (target - current) * weight;
    if (Math.abs(elevation - current) <= 1e-9) continue;
    tile.elevation = elevation;
    changed += 1;
  }

  return changed;
}

function createFrontierTile(
  localX: number,
  localY: number,
  worldSeed: number,
  originX: number,
  originY: number,
): Tile {
  const globalX = originX + localX;
  const globalY = originY + localY;
  const random = createRandom(coordinateSeed(worldSeed, globalX, globalY));
  const conditions = sampleWorldConditions(worldSeed, globalX, globalY);

  if (conditions.elevation < 0.245) {
    return { x: localX, y: localY, terrain: "water", elevation: 0 };
  }

  if (
    conditions.elevation > 0.665 ||
    (conditions.elevation > 0.54 && conditions.slope > 0.68)
  ) {
    const maxAmount = random.int(18, 34) + Math.round(conditions.slope * 8);
    return {
      x: localX,
      y: localY,
      terrain: "hill",
      elevation: Math.max(0.03, conditions.elevation),
      resource: { kind: "stone", amount: maxAmount, maxAmount },
    };
  }

  if (conditions.wetness > 0.585 && conditions.slope < 0.78) {
    const maxAmount = random.int(18, 28) + Math.round(conditions.wetness * 10);
    return {
      x: localX,
      y: localY,
      terrain: "forest",
      elevation: Math.max(0.03, conditions.elevation),
      resource: { kind: "wood", amount: maxAmount, maxAmount },
    };
  }

  const tile: Tile = {
    x: localX,
    y: localY,
    terrain: "plain",
    elevation: Math.max(0.03, conditions.elevation),
  };
  const foodChance = clamp01(
    0.1 +
      conditions.wetness * 0.38 +
      conditions.convergence * 0.06 -
      conditions.slope * 0.16,
  );
  if (random.next() < foodChance) {
    const maxAmount = random.int(12, 24) + Math.round(conditions.wetness * 6);
    tile.resource = { kind: "food", amount: maxAmount, maxAmount };
  }
  return tile;
}

/**
 * Grow older persisted worlds without moving any existing grid coordinate.
 * New cells are sampled from an extent-invariant absolute coordinate field.
 * Callers that split one world into chunks can pass the shared world seed and
 * each chunk's global origin while persisted BOT, structure, command and event
 * coordinates remain local and untouched.
 */
export function ensureWorldExtent(
  state: WorldState,
  targetWidth = TARGET_WORLD_WIDTH,
  targetHeight = TARGET_WORLD_HEIGHT,
  coordinateSpace: WorldCoordinateSpace = {},
): boolean {
  const width = Math.max(state.width, targetWidth);
  const height = Math.max(state.height, targetHeight);
  if (width === state.width && height === state.height) return false;

  const oldWidth = state.width;
  const oldHeight = state.height;
  const oldTiles = state.tiles;
  const tiles: Tile[] = [];
  const worldSeed = coordinateSpace.worldSeed ?? state.seed;
  const originX = Math.trunc(coordinateSpace.originX ?? 0);
  const originY = Math.trunc(coordinateSpace.originY ?? 0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < oldWidth && y < oldHeight) {
        const existing = oldTiles[y * oldWidth + x];
        if (existing !== undefined) {
          tiles.push(existing);
          continue;
        }
      }
      tiles.push(createFrontierTile(x, y, worldSeed, originX, originY));
    }
  }

  state.width = width;
  state.height = height;
  state.tiles = tiles;
  return true;
}
