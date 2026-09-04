const EPSILON = 1e-6;
const SQRT_THREE = Math.sqrt(3);

function safeExtent(value, fallback = 1) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Fit one regular pointy-top hex inside the persisted rectangular extent.
 * A single radius drives both axes so the hex cannot be stretched horizontally.
 */
export function regularHexFootprintSize(width, height) {
  const safeWidth = safeExtent(width);
  const safeHeight = safeExtent(height);
  const radius = Math.min(safeHeight / 2, safeWidth / SQRT_THREE);
  return {
    radius,
    width: radius * SQRT_THREE,
    height: radius * 2,
  };
}

export function hexFootprintVertices(width, height, centerX = 0, centerZ = 0) {
  const footprint = regularHexFootprintSize(width, height);
  const halfWidth = footprint.width / 2;
  const halfHeight = footprint.height / 2;
  const quarterHeight = footprint.height / 4;
  return [
    { x: centerX, z: centerZ - halfHeight },
    { x: centerX + halfWidth, z: centerZ - quarterHeight },
    { x: centerX + halfWidth, z: centerZ + quarterHeight },
    { x: centerX, z: centerZ + halfHeight },
    { x: centerX - halfWidth, z: centerZ + quarterHeight },
    { x: centerX - halfWidth, z: centerZ - quarterHeight },
  ];
}

export function hexFootprintHalfWidthAtZ(z, width, height) {
  const footprint = regularHexFootprintSize(width, height);
  const halfWidth = footprint.width / 2;
  const halfHeight = footprint.height / 2;
  const shoulder = footprint.height / 4;
  const distance = Math.abs(z);
  if (distance > halfHeight) return -1;
  if (distance <= shoulder) return halfWidth;
  return halfWidth * (halfHeight - distance) / (halfHeight - shoulder);
}

export function isPointInsideHexFootprint(x, z, width, height, epsilon = EPSILON) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const limit = hexFootprintHalfWidthAtZ(z, width, height);
  return limit >= 0 && Math.abs(x) <= limit + Math.max(0, epsilon);
}

export function isTileCenterInsideHexFootprint(tile, width, height) {
  if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return false;
  return isPointInsideHexFootprint(
    tile.x + 0.5 - width / 2,
    tile.y + 0.5 - height / 2,
    width,
    height,
  );
}
