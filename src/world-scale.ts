import type { Tile, WorldState } from "./protocol.js";
import { createRandom } from "./prng.js";

export const TARGET_WORLD_WIDTH = 40;
export const TARGET_WORLD_HEIGHT = 24;

export interface WorldCoordinateSpace {
  worldSeed?: number;
  originX?: number;
  originY?: number;
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

/**
 * Low-level terrain conditions sampled from a shared world seed and absolute
 * grid coordinate. The periods are expressed in tiles rather than normalized
 * by the current extent, so growing or chunking the world never rescales the
 * underlying landform field.
 */
export function sampleWorldConditions(
  worldSeed: number,
  globalX: number,
  globalY: number,
): { elevation: number; moisture: number } {
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
  const elevation = clamp01(0.46 + broad * 0.18 + ridge * 0.1 + local * 0.075);
  const moistureWave = Math.cos((x / 34 - y / 29) * Math.PI * 2 + phaseB);
  const moisture = clamp01(
    0.43 + moistureWave * 0.17 + (1 - elevation) * 0.31 + local * 0.08,
  );
  return { elevation, moisture };
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

  if (conditions.elevation > 0.665) {
    const maxAmount = random.int(18, 34);
    return {
      x: localX,
      y: localY,
      terrain: "hill",
      elevation: Math.max(0.03, conditions.elevation),
      resource: { kind: "stone", amount: maxAmount, maxAmount },
    };
  }

  if (conditions.moisture > 0.585) {
    const maxAmount = random.int(20, 38);
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
  const foodChance = 0.18 + conditions.moisture * 0.34;
  if (random.next() < foodChance) {
    const maxAmount = random.int(12, 28);
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
