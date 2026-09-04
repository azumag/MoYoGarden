export interface HexGridPosition {
  x: number;
  y: number;
}

export interface HexGridExtent {
  width: number;
  height: number;
}

export const HEX_GRID_STEPS: readonly HexGridPosition[] = [
  { x: 1, y: 0 },
  { x: 1, y: -1 },
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
];

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
