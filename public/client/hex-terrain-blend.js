import { hexFootprintVertices, isPointInsideHexFootprint } from "./hex-footprint.js";

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return Math.hypot(px - ax, pz - az);
  const projection = ((px - ax) * dx + (pz - az) * dz) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * Euclidean distance from a point outside the active macro hex to its nearest
 * side. Points already inside the center region return zero. This lets the
 * renderer blend only the first few neighbor-cell rows without welding whole
 * chunks into one rectangular surface.
 */
export function distanceOutsideHexFootprint(x, z, width, height) {
  if (![x, z, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (isPointInsideHexFootprint(x, z, width, height)) return 0;

  const vertices = hexFootprintVertices(width, height);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    nearest = Math.min(nearest, pointSegmentDistance(x, z, a.x, a.z, b.x, b.z));
  }
  return nearest;
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/**
 * Pull the first neighbor-cell row to the nearest center-region surface and
 * ease back to the neighbor's native height over the next few rows. Keeping
 * the native height as an explicit input makes this idempotent across repeated
 * render refreshes.
 */
export function blendBoundaryHeight(
  nativeHeight,
  targetHeight,
  boundaryDistance,
  cellRadius,
  blendRows = 2,
) {
  if (![nativeHeight, targetHeight, boundaryDistance, cellRadius].every(Number.isFinite)) {
    return nativeHeight;
  }
  if (cellRadius <= 0) return nativeHeight;

  const lockedBand = cellRadius * 1.05;
  if (boundaryDistance <= lockedBand) return targetHeight;
  const span = cellRadius * Math.max(0.5, Number.isFinite(blendRows) ? blendRows : 2);
  const t = smoothstep((boundaryDistance - lockedBand) / span);
  return targetHeight * (1 - t) + nativeHeight * t;
}

export function nearestHeightSample(x, z, samples, maxDistance = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Array.isArray(samples)) return undefined;
  const safeMaximum = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Number.POSITIVE_INFINITY;
  let nearest;
  for (const sample of samples) {
    if (!Number.isFinite(sample?.x) || !Number.isFinite(sample?.z) || !Number.isFinite(sample?.height)) {
      continue;
    }
    const distance = Math.hypot(sample.x - x, sample.z - z);
    if (distance > safeMaximum) continue;
    if (nearest === undefined || distance < nearest.distance) {
      nearest = { ...sample, distance };
    }
  }
  return nearest;
}
