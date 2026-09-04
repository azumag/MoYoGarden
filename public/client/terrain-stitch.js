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

function parseBoundarySamples(boundaryHeights) {
  const samples = [];
  for (const [key, height] of boundaryHeights) {
    if (!Number.isFinite(height)) continue;
    const separator = key.indexOf(":");
    if (separator <= 0) continue;
    const x = Number(key.slice(0, separator));
    const z = Number(key.slice(separator + 1));
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    samples.push({ x, z, height });
  }
  return samples;
}

function interpolateLine(samples, coordinate, axis) {
  let exact;
  let lower;
  let upper;
  for (const sample of samples) {
    const value = axis === "x" ? sample.x : sample.z;
    const delta = value - coordinate;
    if (Math.abs(delta) <= KEY_EPSILON) {
      exact = sample;
      break;
    }
    if (delta < 0 && (lower === undefined || value > (axis === "x" ? lower.x : lower.z))) {
      lower = sample;
    }
    if (delta > 0 && (upper === undefined || value < (axis === "x" ? upper.x : upper.z))) {
      upper = sample;
    }
  }
  if (exact !== undefined) return exact.height;
  if (lower === undefined || upper === undefined) return undefined;
  const low = axis === "x" ? lower.x : lower.z;
  const high = axis === "x" ? upper.x : upper.z;
  if (high - low <= KEY_EPSILON) return (lower.height + upper.height) * 0.5;
  const t = (coordinate - low) / (high - low);
  return lower.height * (1 - t) + upper.height * t;
}

function nearestBoundarySample(cornerX, cornerZ, boundaryHeights, maxDistance) {
  const samples = parseBoundarySamples(boundaryHeights);
  if (samples.length === 0) return undefined;

  const verticalLines = new Map();
  const horizontalLines = new Map();
  for (const sample of samples) {
    const xKey = Number(sample.x).toFixed(KEY_PRECISION);
    const zKey = Number(sample.z).toFixed(KEY_PRECISION);
    const vertical = verticalLines.get(xKey) ?? [];
    vertical.push(sample);
    verticalLines.set(xKey, vertical);
    const horizontal = horizontalLines.get(zKey) ?? [];
    horizontal.push(sample);
    horizontalLines.set(zKey, horizontal);
  }

  let best;
  for (const line of verticalLines.values()) {
    const distance = Math.abs(cornerX - line[0].x);
    if (distance >= maxDistance) continue;
    const height = interpolateLine(line, cornerZ, "z");
    if (!Number.isFinite(height)) continue;
    if (best === undefined || distance < best.distance) best = { height, distance };
  }
  for (const line of horizontalLines.values()) {
    const distance = Math.abs(cornerZ - line[0].z);
    if (distance >= maxDistance) continue;
    const height = interpolateLine(line, cornerX, "x");
    if (!Number.isFinite(height)) continue;
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

  const boundary = nearestBoundarySample(
    cornerX,
    cornerZ,
    boundaryHeights,
    safeBlendDistance,
  );
  if (boundary === undefined) return native;
  if (boundary.distance <= KEY_EPSILON) return boundary.height;

  const nativeWeight = smoothstep(boundary.distance / safeBlendDistance);
  return boundary.height * (1 - nativeWeight) + native * nativeWeight;
}
