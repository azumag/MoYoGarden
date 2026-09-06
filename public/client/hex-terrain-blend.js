import { hexFootprintVertices, isPointInsideHexFootprint } from "./hex-footprint.js";

const BOUNDARY_SAMPLE_EPSILON = 1e-3;

function pointSegmentProjection(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) {
    return { x: ax, z: az, t: 0, distance: Math.hypot(px - ax, pz - az) };
  }
  const projection = ((px - ax) * dx + (pz - az) * dz) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const x = ax + dx * t;
  const z = az + dz * t;
  return { x, z, t, distance: Math.hypot(px - x, pz - z) };
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  return pointSegmentProjection(px, pz, ax, az, bx, bz).distance;
}

function nearestHexSideProjection(x, z, width, height) {
  const vertices = hexFootprintVertices(width, height);
  let nearest;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const projection = pointSegmentProjection(x, z, a.x, a.z, b.x, b.z);
    if (nearest === undefined || projection.distance < nearest.distance - 1e-12) {
      nearest = { ...projection, a, b, sideIndex: index };
    }
  }
  return nearest;
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

/**
 * Sample the center region's height profile at the nearest point on the real
 * macro-hex boundary. Boundary meshes do not necessarily contain identical
 * vertices on both sides of a seam, so using the nearest vertex height can
 * create a vertical zipper when neighboring terrain has a steep gradient.
 * Interpolating between the two center-boundary samples that bracket the
 * projected point gives both independently tessellated chunks the same seam
 * profile without changing either chunk away from the blend band.
 */
export function interpolateHexBoundaryHeight(
  x,
  z,
  samples,
  width,
  height,
  maxDistance = Number.POSITIVE_INFINITY,
) {
  if (
    ![x, z, width, height].every(Number.isFinite)
    || width <= 0
    || height <= 0
    || !Array.isArray(samples)
  ) {
    return undefined;
  }

  const side = nearestHexSideProjection(x, z, width, height);
  if (side === undefined) return undefined;
  const safeMaximum = Number.isFinite(maxDistance)
    ? Math.max(0, maxDistance)
    : Number.POSITIVE_INFINITY;
  if (side.distance > safeMaximum) return undefined;

  const tolerance = Math.max(
    BOUNDARY_SAMPLE_EPSILON,
    Math.min(width, height) * 1e-5,
  );
  const edgeSamples = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample?.x) || !Number.isFinite(sample?.z) || !Number.isFinite(sample?.height)) {
      continue;
    }
    const projected = pointSegmentProjection(
      sample.x,
      sample.z,
      side.a.x,
      side.a.z,
      side.b.x,
      side.b.z,
    );
    if (projected.distance > tolerance) continue;
    edgeSamples.push({ t: projected.t, height: sample.height });
  }
  if (edgeSamples.length === 0) return undefined;
  edgeSamples.sort((a, b) => a.t - b.t);

  let lower;
  let upper;
  for (const sample of edgeSamples) {
    if (Math.abs(sample.t - side.t) <= 1e-9) {
      return { x: side.x, z: side.z, height: sample.height, distance: side.distance };
    }
    if (sample.t < side.t) lower = sample;
    if (sample.t > side.t) {
      upper = sample;
      break;
    }
  }
  if (lower === undefined || upper === undefined) return undefined;
  const span = upper.t - lower.t;
  if (span <= 1e-12) return undefined;
  const t = (side.t - lower.t) / span;
  return {
    x: side.x,
    z: side.z,
    height: lower.height * (1 - t) + upper.height * t,
    distance: side.distance,
  };
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
