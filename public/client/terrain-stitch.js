const KEY_PRECISION = 4;
const KEY_EPSILON = 10 ** -KEY_PRECISION;
const DEFAULT_EDGE_BLEND_DISTANCE = 3;

export function terrainVertexKey(x, z) {
  return `${Number(x).toFixed(KEY_PRECISION)}:${Number(z).toFixed(KEY_PRECISION)}`;
}

export function collectBoundaryHeights(
  positions,
  halfWidth,
  halfHeight,
  epsilon = 0.0001,
) {
  const heights = new Map();
  if (!positions) return heights;

  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = Number(positions[index]);
    const y = Number(positions[index + 1]);
    const z = Number(positions[index + 2]);
    if (![x, y, z].every(Number.isFinite)) continue;
    const onBoundary =
      Math.abs(Math.abs(x) - halfWidth) <= epsilon ||
      Math.abs(Math.abs(z) - halfHeight) <= epsilon;
    if (!onBoundary) continue;
    const key = terrainVertexKey(x, z);
    const previous = heights.get(key);
    if (previous === undefined || y > previous) heights.set(key, y);
  }
  return heights;
}

function nativeCornerHeight(cornerX, cornerZ, tileHeights) {
  let total = 0;
  let samples = 0;
  for (const dx of [-0.5, 0.5]) {
    for (const dz of [-0.5, 0.5]) {
      const height = tileHeights.get(terrainVertexKey(cornerX + dx, cornerZ + dz));
      if (!Number.isFinite(height)) continue;
      total += height;
      samples += 1;
    }
  }
  return samples > 0 ? total / samples : 0;
}

function nearestAlignedBoundarySample(cornerX, cornerZ, boundaryHeights, maxDistance) {
  let best;
  for (const [key, height] of boundaryHeights) {
    if (!Number.isFinite(height)) continue;
    const separator = key.indexOf(":");
    if (separator <= 0) continue;
    const x = Number(key.slice(0, separator));
    const z = Number(key.slice(separator + 1));
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

    const dx = Math.abs(cornerX - x);
    const dz = Math.abs(cornerZ - z);
    let distance;
    if (dz <= KEY_EPSILON) distance = dx;
    else if (dx <= KEY_EPSILON) distance = dz;
    else continue;
    if (distance <= KEY_EPSILON || distance >= maxDistance) continue;
    if (best === undefined || distance < best.distance) best = { height, distance };
  }
  return best;
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function resolvePreviewCornerHeight(
  cornerX,
  cornerZ,
  tileHeights,
  boundaryHeights = new Map(),
  blendDistance = DEFAULT_EDGE_BLEND_DISTANCE,
) {
  const stitched = boundaryHeights.get(terrainVertexKey(cornerX, cornerZ));
  if (Number.isFinite(stitched)) return stitched;

  const native = nativeCornerHeight(cornerX, cornerZ, tileHeights);
  const safeBlendDistance = Number.isFinite(blendDistance)
    ? Math.max(0, blendDistance)
    : DEFAULT_EDGE_BLEND_DISTANCE;
  if (safeBlendDistance <= 0) return native;

  const boundary = nearestAlignedBoundarySample(
    cornerX,
    cornerZ,
    boundaryHeights,
    safeBlendDistance,
  );
  if (boundary === undefined) return native;

  const nativeWeight = smoothstep(boundary.distance / safeBlendDistance);
  return boundary.height * (1 - nativeWeight) + native * nativeWeight;
}
