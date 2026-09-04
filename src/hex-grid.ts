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

export function isHexGridCell(extent: HexGridExtent, position: HexGridPosition): boolean {
  if (
    !Number.isInteger(position.x) ||
    !Number.isInteger(position.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x >= extent.width ||
    position.y >= extent.height
  ) {
    return false;
  }
  return hexGridDistance(position, hexGridCenter(extent)) <= hexGridRadius(extent);
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

/**
 * Return the local cells whose next step in `direction` leaves the active hex.
 * The ordering follows the side tangent, making it deterministic and suitable
 * for one-to-one transfer onto the opposite side of a neighboring region.
 */
export function hexGridBoundaryCells(
  extent: HexGridExtent,
  direction: HexGridDirection,
): HexGridPosition[] {
  const step = HEX_GRID_DIRECTION_STEPS[direction];
  const cells: HexGridPosition[] = [];
  for (let y = 0; y < extent.height; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      const position = { x, y };
      if (!isHexGridCell(extent, position)) continue;
      if (isHexGridCell(extent, { x: x + step.x, y: y + step.y })) continue;
      cells.push(position);
    }
  }
  return cells.sort((a, b) =>
    boundaryTangentScore(extent, a, direction) - boundaryTangentScore(extent, b, direction) ||
    a.y - b.y ||
    a.x - b.x
  );
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
  const sourceSide = hexGridBoundaryCells(extent, direction);
  const sourceIndex = sourceSide.findIndex(
    (position) => position.x === source.x && position.y === source.y,
  );
  if (sourceIndex < 0) return undefined;

  const targetSide = hexGridBoundaryCells(extent, oppositeHexGridDirection(direction));
  if (targetSide.length !== sourceSide.length) return undefined;
  return targetSide[targetSide.length - 1 - sourceIndex];
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
  let best: HexGridPosition | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < extent.height; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      const candidate = { x, y };
      if (!isHexGridCell(extent, candidate) || !predicate(candidate)) continue;
      const distance = hexGridDistance(candidate, desired);
      if (
        distance < bestDistance ||
        (distance === bestDistance && best !== undefined && (y < best.y || y === best.y && x < best.x))
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}
