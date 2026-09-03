import type { Tile, WorldState } from "./protocol.js";
import { createRandom } from "./prng.js";

export const TARGET_WORLD_WIDTH = 40;
export const TARGET_WORLD_HEIGHT = 24;

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

function frontierConditions(
  seed: number,
  x: number,
  y: number,
  width: number,
  height: number,
): { elevation: number; moisture: number } {
  const nx = (x + 0.5) / Math.max(1, width);
  const ny = (y + 0.5) / Math.max(1, height);
  const phaseA = seededUnit(seed, 0x41c64e6d) * Math.PI * 2;
  const phaseB = seededUnit(seed, 0x9e3779b9) * Math.PI * 2;
  const phaseC = seededUnit(seed, 0x7f4a7c15) * Math.PI * 2;
  const broad = (
    Math.sin(nx * Math.PI * 2.2 + phaseA) +
    Math.cos(ny * Math.PI * 2.6 + phaseB)
  ) * 0.5;
  const ridge = Math.sin((nx * 1.7 + ny * 1.15) * Math.PI * 3.2 + phaseC);
  const local = seededUnit(seed, coordinateSeed(seed, x, y)) - 0.5;
  const elevation = clamp01(0.46 + broad * 0.18 + ridge * 0.1 + local * 0.075);
  const moistureWave = Math.cos((nx * 0.85 - ny * 1.35) * Math.PI * 2.4 + phaseB);
  const moisture = clamp01(
    0.43 + moistureWave * 0.17 + (1 - elevation) * 0.31 + local * 0.08,
  );
  return { elevation, moisture };
}

function createFrontierTile(
  seed: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Tile {
  const random = createRandom(coordinateSeed(seed, x, y));
  const conditions = frontierConditions(seed, x, y, width, height);

  if (conditions.elevation < 0.245) {
    return { x, y, terrain: "water", elevation: 0 };
  }

  if (conditions.elevation > 0.665) {
    const maxAmount = random.int(18, 34);
    return {
      x,
      y,
      terrain: "hill",
      elevation: Math.max(0.03, conditions.elevation),
      resource: { kind: "stone", amount: maxAmount, maxAmount },
    };
  }

  if (conditions.moisture > 0.585) {
    const maxAmount = random.int(20, 38);
    return {
      x,
      y,
      terrain: "forest",
      elevation: Math.max(0.03, conditions.elevation),
      resource: { kind: "wood", amount: maxAmount, maxAmount },
    };
  }

  const tile: Tile = {
    x,
    y,
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
 * The added east/south frontier is deterministic from seed + position, so a
 * repeated migration produces exactly the same land while keeping saved BOT,
 * structure, command and event coordinates valid.
 */
export function ensureWorldExtent(
  state: WorldState,
  targetWidth = TARGET_WORLD_WIDTH,
  targetHeight = TARGET_WORLD_HEIGHT,
): boolean {
  const width = Math.max(state.width, targetWidth);
  const height = Math.max(state.height, targetHeight);
  if (width === state.width && height === state.height) return false;

  const oldWidth = state.width;
  const oldHeight = state.height;
  const oldTiles = state.tiles;
  const tiles: Tile[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < oldWidth && y < oldHeight) {
        const existing = oldTiles[y * oldWidth + x];
        if (existing !== undefined) {
          tiles.push(existing);
          continue;
        }
      }
      tiles.push(createFrontierTile(state.seed, x, y, width, height));
    }
  }

  state.width = width;
  state.height = height;
  state.tiles = tiles;
  return true;
}
