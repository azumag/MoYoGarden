const KEY_PRECISION = 4;

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

export function resolvePreviewCornerHeight(
  cornerX,
  cornerZ,
  tileHeights,
  boundaryHeights = new Map(),
) {
  const stitched = boundaryHeights.get(terrainVertexKey(cornerX, cornerZ));
  if (Number.isFinite(stitched)) return stitched;

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
