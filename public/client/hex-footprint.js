const EPSILON = 1e-6;

function safeExtent(value, fallback = 1) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function hexFootprintVertices(width, height, centerX = 0, centerZ = 0) {
  const safeWidth = safeExtent(width);
  const safeHeight = safeExtent(height);
  const halfWidth = safeWidth / 2;
  const halfHeight = safeHeight / 2;
  const quarterHeight = safeHeight / 4;
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
  const safeWidth = safeExtent(width);
  const safeHeight = safeExtent(height);
  const halfWidth = safeWidth / 2;
  const halfHeight = safeHeight / 2;
  const shoulder = safeHeight / 4;
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
