import { TARGET_WORLD_HEIGHT, TARGET_WORLD_WIDTH } from "./world-scale.js";

export const HEX_DIRECTIONS = [
  "east",
  "northEast",
  "northWest",
  "west",
  "southWest",
  "southEast",
] as const;

export type HexDirection = (typeof HEX_DIRECTIONS)[number];

export interface HexCoordinate {
  q: number;
  r: number;
}

export interface HexWorldOrigin {
  x: number;
  y: number;
}

export interface RegionHexTopologyEntry {
  id: string;
  index: number;
  axial: HexCoordinate;
  physicalOrigin: HexWorldOrigin;
  hexOrigin: HexWorldOrigin;
  ring: number;
  neighbors: Record<HexDirection, string | null>;
}

const HEX_STEPS: Readonly<Record<HexDirection, HexCoordinate>> = {
  east: { q: 1, r: 0 },
  northEast: { q: 1, r: -1 },
  northWest: { q: 0, r: -1 },
  west: { q: -1, r: 0 },
  southWest: { q: -1, r: 1 },
  southEast: { q: 0, r: 1 },
};

export function hexDistance(a: HexCoordinate, b: HexCoordinate = { q: 0, r: 0 }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

/**
 * Return the persisted rectangular region origin used during the hex migration.
 * Keeping this explicit lets API clients distinguish storage ownership from the
 * logical/display hex placement until Durable Object ownership is migrated.
 */
export function projectPhysicalRegionOrigin(
  index: number,
  width = TARGET_WORLD_WIDTH,
): HexWorldOrigin {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : TARGET_WORLD_WIDTH;
  return { x: safeIndex * safeWidth, y: 0 };
}

/**
 * Project axial coordinates into the current global-grid coordinate space.
 *
 * The migration intentionally preserves the existing east/west spacing: an
 * east neighbor remains exactly one current region width away. Diagonal
 * neighbors sit half a region width sideways and three quarters of a region
 * height vertically, matching a pointy-top hex center lattice while keeping
 * the persisted rectangular WorldState untouched.
 */
export function projectHexCoordinate(
  coordinate: HexCoordinate,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): HexWorldOrigin {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : TARGET_WORLD_WIDTH;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : TARGET_WORLD_HEIGHT;
  return {
    x: (coordinate.q + coordinate.r * 0.5) * safeWidth,
    y: coordinate.r * safeHeight * 0.75,
  };
}

export function regionHexTopology(
  regionIds: readonly string[],
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): RegionHexTopologyEntry[] {
  if (regionIds.length === 0) return [];

  const coordinates: HexCoordinate[] = [];
  const queue: HexCoordinate[] = [{ q: 0, r: 0 }];
  const seen = new Set([coordinateKey(0, 0)]);

  while (coordinates.length < regionIds.length) {
    const coordinate = queue.shift();
    if (coordinate === undefined) break;
    coordinates.push(coordinate);

    for (const direction of HEX_DIRECTIONS) {
      const step = HEX_STEPS[direction];
      const next = { q: coordinate.q + step.q, r: coordinate.r + step.r };
      const key = coordinateKey(next.q, next.r);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }

  const idByCoordinate = new Map<string, string>();
  coordinates.forEach((coordinate, index) => {
    const id = regionIds[index];
    if (id !== undefined) idByCoordinate.set(coordinateKey(coordinate.q, coordinate.r), id);
  });

  return coordinates.map((coordinate, index) => {
    const neighbors = Object.fromEntries(
      HEX_DIRECTIONS.map((direction) => {
        const step = HEX_STEPS[direction];
        const key = coordinateKey(coordinate.q + step.q, coordinate.r + step.r);
        return [direction, idByCoordinate.get(key) ?? null];
      }),
    ) as Record<HexDirection, string | null>;

    return {
      id: regionIds[index] ?? `region-${index}`,
      index,
      axial: coordinate,
      physicalOrigin: projectPhysicalRegionOrigin(index, width),
      hexOrigin: projectHexCoordinate(coordinate, width, height),
      ring: hexDistance(coordinate),
      neighbors,
    };
  });
}

function coordinateKey(q: number, r: number): string {
  return `${q},${r}`;
}
