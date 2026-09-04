import {
  HEX_GRID_STEPS,
  hexGridCenter,
  hexGridRadius,
  isHexGridCell,
} from "./hex-grid.js";
import type { Tile, WorldState } from "./protocol.js";
import { createRandom } from "./prng.js";
import { migrateWorldToHexGrid } from "./world.js";

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
  temperature: number;
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
 * Sample low-level environment state on the same axial coordinate system used by
 * movement, perception and hydrology. Slope/convergence use all six equidistant
 * hex neighbors; no square-grid cardinal/diagonal distinction remains.
 */
export function sampleWorldConditions(
  worldSeed: number,
  globalX: number,
  globalY: number,
): WorldConditions {
  const x = globalX + 0.5;
  const y = globalY + 0.5;
  const phaseB = seededUnit(worldSeed, 0x9e3779b9) * Math.PI * 2;
  const phaseTemperature = seededUnit(worldSeed, 0x6a09e667) * Math.PI * 2;
  const elevation = elevationAt(worldSeed, globalX, globalY);
  const local = seededUnit(worldSeed, coordinateSeed(worldSeed, globalX, globalY)) - 0.5;
  const moistureWave = Math.cos((x / 34 - y / 29) * Math.PI * 2 + phaseB);
  const moisture = clamp01(
    0.43 + moistureWave * 0.17 + (1 - elevation) * 0.31 + local * 0.08,
  );

  const climateBand = Math.cos((y / 128) * Math.PI * 2 + phaseTemperature * 0.5);
  const continentalWave = Math.sin(
    (x / 96 + y / 132) * Math.PI * 2 + phaseTemperature,
  );
  const temperature = clamp01(
    0.62 + climateBand * 0.16 + continentalWave * 0.07 - elevation * 0.3 + local * 0.04,
  );

  const neighborElevations = HEX_GRID_STEPS.map((step) =>
    elevationAt(worldSeed, globalX + step.x, globalY + step.y),
  );
  const rawSlope = neighborElevations.reduce(
    (maximum, neighbor) => Math.max(maximum, Math.abs(neighbor - elevation)),
    0,
  );
  const slope = clamp01(rawSlope / 0.16);
  const neighborMean = neighborElevations.reduce((sum, value) => sum + value, 0) /
    Math.max(1, neighborElevations.length);
  const convergence = clamp01(0.5 + (neighborMean - elevation) * 6);
  const wetness = clamp01(
    moisture +
      (1 - elevation) * 0.08 +
      (convergence - 0.5) * 0.16 -
      slope * 0.12,
  );

  return { elevation, moisture, temperature, slope, convergence, wetness };
}

/**
 * Preserve the existing four legacy physical-edge flags while measuring their
 * bands on the active axial hex, not on the rectangular storage envelope.
 * The two remaining diagonal hex sides are handled by the newer topology/halo
 * migration path rather than fabricating rectangular edge cells.
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
  const center = hexGridCenter(state);
  const radius = hexGridRadius(state);
  let changed = 0;

  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile) || tile.terrain === "water") continue;
    const q = tile.x - center.x;
    const r = tile.y - center.y;
    const edgeDistances: number[] = [];
    if (edges.west) edgeDistances.push(q + radius);
    if (edges.east) edgeDistances.push(radius - q);
    if (edges.north) edgeDistances.push(r + radius);
    if (edges.south) edgeDistances.push(radius - r);
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
    const elevation = distance === 0 ? target : current + (target - current) * weight;
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
  const temperatureSuitability = clamp01(
    1 - Math.abs(conditions.temperature - 0.58) / 0.58,
  );

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
    const maxAmount =
      random.int(18, 28) +
      Math.round(conditions.wetness * 10) +
      Math.round(temperatureSuitability * 4);
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
      conditions.slope * 0.16 +
      (temperatureSuitability - 0.5) * 0.08,
  );
  if (random.next() < foodChance) {
    const maxAmount =
      random.int(12, 24) +
      Math.round(conditions.wetness * 6) +
      Math.round(temperatureSuitability * 4);
    tile.resource = { kind: "food", amount: maxAmount, maxAmount };
  }
  return tile;
}

export function ensureWorldExtent(
  state: WorldState,
  targetWidth = TARGET_WORLD_WIDTH,
  targetHeight = TARGET_WORLD_HEIGHT,
  coordinateSpace: WorldCoordinateSpace = {},
): boolean {
  const width = Math.max(state.width, targetWidth);
  const height = Math.max(state.height, targetHeight);
  const extentChanged = width !== state.width || height !== state.height;

  if (extentChanged) {
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
  }

  const migrated = migrateWorldToHexGrid(state);
  return extentChanged || migrated > 0;
}
