export interface HexGridPosition {
  x: number;
  y: number;
}

export interface HexGridExtent {
  width: number;
  height: number;
}

export const HEX_GRID_DIRECTIONS = [
  "east",
  "northEast",
  "northWest",
  "west",
  "southWest",
  "southEast",
] as const;

export type HexGridDirection = (typeof HEX_GRID_DIRECTIONS)[number];

export const HEX_GRID_DIRECTION_STEPS: Readonly<Record<HexGridDirection, HexGridPosition>> = {
  east: { x: 1, y: 0 },
  northEast: { x: 1, y: -1 },
  northWest: { x: 0, y: -1 },
  west: { x: -1, y: 0 },
  southWest: { x: -1, y: 1 },
  southEast: { x: 0, y: 1 },
};

export const HEX_GRID_STEPS: readonly HexGridPosition[] = HEX_GRID_DIRECTIONS.map(
  (direction) => HEX_GRID_DIRECTION_STEPS[direction],
);

const OPPOSITE_HEX_GRID_DIRECTION: Readonly<Record<HexGridDirection, HexGridDirection>> = {
  east: "west",
  northEast: "southWest",
  northWest: "southEast",
  west: "east",
  southWest: "northEast",
  southEast: "northWest",
};

export function hexGridDistance(a: HexGridPosition, b: HexGridPosition): number {
  const dq = a.x - b.x;
  const dr = a.y - b.y;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

export function hexGridCenter(extent: HexGridExtent): HexGridPosition {
  return {
    x: Math.floor((extent.width - 1) / 2),
    y: Math.floor((extent.height - 1) / 2),
  };
}

export function hexGridRadius(extent: HexGridExtent): number {
  const center = hexGridCenter(extent);
  return Math.max(
    1,
    Math.min(
      center.x,
      extent.width - 1 - center.x,
      center.y,
      extent.height - 1 - center.y,
    ),
  );
}

interface HexGridCellCacheEntry {
  cells: readonly HexGridPosition[];
  mask: Uint8Array;
}

const HEX_GRID_CELL_CACHE_LIMIT = 24;
const hexGridCellCache = new Map<string, HexGridCellCacheEntry>();

function hexGridCellCacheKey(extent: HexGridExtent): string {
  return `${extent.width}x${extent.height}`;
}

function cellIndex(extent: HexGridExtent, position: HexGridPosition): number {
  return position.y * extent.width + position.x;
}

function cachedHexGridCells(extent: HexGridExtent): HexGridCellCacheEntry {
  const key = hexGridCellCacheKey(extent);
  const cached = hexGridCellCache.get(key);
  if (cached !== undefined) {
    // Treat the bounded map as an LRU rather than insertion-order FIFO. Tests,
    // preview windows and compatibility tooling can touch many temporary
    // extents; refreshing a hit keeps the production 40x24 footprint resident
    // instead of evicting it just because it was inserted early.
    hexGridCellCache.delete(key);
    hexGridCellCache.set(key, cached);
    return cached;
  }

  const center = hexGridCenter(extent);
  const radius = hexGridRadius(extent);
  const cells: HexGridPosition[] = [];
  const mask = new Uint8Array(Math.max(0, extent.width * extent.height));
  for (let y = 0; y < extent.height; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      const position = { x, y };
      if (hexGridDistance(position, center) > radius) continue;
      cells.push(position);
      mask[cellIndex(extent, position)] = 1;
    }
  }
  const entry: HexGridCellCacheEntry = { cells, mask };

  if (hexGridCellCache.size >= HEX_GRID_CELL_CACHE_LIMIT) {
    const oldest = hexGridCellCache.keys().next().value;
    if (oldest !== undefined) hexGridCellCache.delete(oldest);
  }
  hexGridCellCache.set(key, entry);
  return entry;
}

/**
 * Return the active axial cells inside the rectangular compatibility envelope.
 *
 * The 40x24 storage shape is queried from movement, pathfinding, handoff, halo,
 * migration and rendering helpers many times per simulation step. Cache the pure
 * extent-derived footprint once and return detached positions so callers cannot
 * mutate shared geometry. The cache is bounded because tests/tools may construct
 * alternate extents even though production normally uses a single 40x24 shape.
 */
export function hexGridCells(extent: HexGridExtent): HexGridPosition[] {
  return cachedHexGridCells(extent).cells.map((position) => ({ ...position }));
}

export function isHexGridCell(extent: HexGridExtent, position: HexGridPosition): boolean {
  const x = position.x;
  const y = position.y;
  const width = extent.width;
  const height = extent.height;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height
  ) {
    return false;
  }

  // Membership is one of the hottest geometry predicates in movement,
  // migration, halo and rendering. Compute the pure axial test inline instead
  // of allocating two center objects through hexGridCenter()/hexGridRadius()
  // on every call. Keep the exact same center/radius formula so odd/even and
  // non-production extents retain the existing deterministic footprint.
  const centerX = Math.floor((width - 1) / 2);
  const centerY = Math.floor((height - 1) / 2);
  const radius = Math.max(
    1,
    Math.min(
      centerX,
      width - 1 - centerX,
      centerY,
      height - 1 - centerY,
    ),
  );
  const dq = x - centerX;
  const dr = y - centerY;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds)) <= radius;
}

export function hexGridNeighbors(position: HexGridPosition): HexGridPosition[] {
  return HEX_GRID_STEPS.map((step) => ({
    x: position.x + step.x,
    y: position.y + step.y,
  }));
}

export function oppositeHexGridDirection(direction: HexGridDirection): HexGridDirection {
  return OPPOSITE_HEX_GRID_DIRECTION[direction];
}

function projectedLocalPosition(
  extent: HexGridExtent,
  position: HexGridPosition,
): { x: number; y: number } {
  const center = hexGridCenter(extent);
  const q = position.x - center.x;
  const r = position.y - center.y;
  return {
    x: q + r * 0.5,
    y: r * Math.sqrt(3) * 0.5,
  };
}

function boundaryTangentScore(
  extent: HexGridExtent,
  position: HexGridPosition,
  direction: HexGridDirection,
): number {
  const projected = projectedLocalPosition(extent, position);
  const step = HEX_GRID_DIRECTION_STEPS[direction];
  const projectedStep = {
    x: step.x + step.y * 0.5,
    y: step.y * Math.sqrt(3) * 0.5,
  };
  const tangent = { x: -projectedStep.y, y: projectedStep.x };
  return projected.x * tangent.x + projected.y * tangent.y;
}

interface HexGridBoundaryCacheEntry {
  cells: readonly HexGridPosition[];
  indexByPosition: ReadonlyMap<string, number>;
}

const HEX_GRID_BOUNDARY_CACHE_LIMIT = 24;
const hexGridBoundaryCache = new Map<string, HexGridBoundaryCacheEntry>();

function hexGridBoundaryCacheKey(
  extent: HexGridExtent,
  direction: HexGridDirection,
): string {
  return `${extent.width}x${extent.height}:${direction}`;
}

function cachedHexGridBoundary(
  extent: HexGridExtent,
  direction: HexGridDirection,
): HexGridBoundaryCacheEntry {
  const key = hexGridBoundaryCacheKey(extent, direction);
  const cached = hexGridBoundaryCache.get(key);
  if (cached !== undefined) {
    // Boundary geometry is even more frequently reused by six-direction halo
    // reads and ownership handoff. Promote cache hits so transient alternate
    // extents cannot churn out the hot production sides.
    hexGridBoundaryCache.delete(key);
    hexGridBoundaryCache.set(key, cached);
    return cached;
  }

  const step = HEX_GRID_DIRECTION_STEPS[direction];
  const active = cachedHexGridCells(extent);
  const cells: HexGridPosition[] = [];
  for (const position of active.cells) {
    const next = { x: position.x + step.x, y: position.y + step.y };
    if (
      next.x >= 0 &&
      next.y >= 0 &&
      next.x < extent.width &&
      next.y < extent.height &&
      active.mask[cellIndex(extent, next)] === 1
    ) continue;
    cells.push({ ...position });
  }
  cells.sort((a, b) =>
    boundaryTangentScore(extent, a, direction) - boundaryTangentScore(extent, b, direction) ||
    a.y - b.y ||
    a.x - b.x
  );
  const entry: HexGridBoundaryCacheEntry = {
    cells,
    indexByPosition: new Map(cells.map((position, index) => [`${position.x},${position.y}`, index])),
  };

  if (hexGridBoundaryCache.size >= HEX_GRID_BOUNDARY_CACHE_LIMIT) {
    const oldest = hexGridBoundaryCache.keys().next().value;
    if (oldest !== undefined) hexGridBoundaryCache.delete(oldest);
  }
  hexGridBoundaryCache.set(key, entry);
  return entry;
}

/**
 * Return the local cells whose next step in `direction` leaves the active hex.
 * The ordering follows the side tangent, making it deterministic and suitable
 * for one-to-one transfer onto the opposite side of a neighboring region.
 *
 * Boundary discovery is cached by extent/direction because halo, handoff and
 * topology code repeatedly asks for the same six sides. Return fresh positions
 * so callers cannot mutate the shared geometry cache.
 */
export function hexGridBoundaryCells(
  extent: HexGridExtent,
  direction: HexGridDirection,
): HexGridPosition[] {
  return cachedHexGridBoundary(extent, direction).cells.map((position) => ({ ...position }));
}

/**
 * Map a boundary cell to the corresponding entry cell in the neighboring
 * region. Hex clusters do not share one rectangular row/column, so the mapping
 * pairs the ordered source side with the reversed opposite side rather than
 * translating rectangular x/y coordinates.
 */
export function hexGridHandoffTarget(
  extent: HexGridExtent,
  source: HexGridPosition,
  direction: HexGridDirection,
): HexGridPosition | undefined {
  if (!isHexGridCell(extent, source)) return undefined;
  const sourceSide = cachedHexGridBoundary(extent, direction);
  const sourceIndex = sourceSide.indexByPosition.get(`${source.x},${source.y}`);
  if (sourceIndex === undefined) return undefined;

  const targetSide = cachedHexGridBoundary(extent, oppositeHexGridDirection(direction)).cells;
  if (targetSide.length !== sourceSide.cells.length) return undefined;
  const target = targetSide[targetSide.length - 1 - sourceIndex];
  return target === undefined ? undefined : { ...target };
}

export function hexGridCrossingDirection(
  extent: HexGridExtent,
  source: HexGridPosition,
  desired: HexGridPosition,
): HexGridDirection | undefined {
  if (!isHexGridCell(extent, source) || isHexGridCell(extent, desired)) return undefined;
  return HEX_GRID_DIRECTIONS.find((direction) => {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    return source.x + step.x === desired.x && source.y + step.y === desired.y;
  });
}

export function nearestHexGridCell(
  extent: HexGridExtent,
  desired: HexGridPosition,
  predicate: (position: HexGridPosition) => boolean = () => true,
): HexGridPosition | undefined {
  // The most common clamp/fallback case already points at a valid active cell.
  // Distance zero is unbeatable, so test that candidate exactly once before
  // scanning the 397-cell production footprint. Predicates used here are
  // selection constraints; callers must not depend on scan-side effects.
  if (isHexGridCell(extent, desired) && predicate(desired)) return { ...desired };

  let best: HexGridPosition | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of cachedHexGridCells(extent).cells) {
    const distance = hexGridDistance(candidate, desired);
    // Once a valid candidate is known, farther cells cannot change either
    // the nearest-distance result or its deterministic y/x tie-break. Avoid
    // invoking potentially expensive passability/resource predicates for
    // those cells; handoff entry fallback and persisted-state migration both
    // use this helper on the 397-cell active hex.
    if (distance > bestDistance || !predicate(candidate)) continue;
    if (
      distance < bestDistance ||
      (
        distance === bestDistance &&
        best !== undefined &&
        (candidate.y < best.y || candidate.y === best.y && candidate.x < best.x)
      )
    ) {
      best = { ...candidate };
      bestDistance = distance;
    }
  }
  return best;
}
