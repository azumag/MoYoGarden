function finiteOrigin(value) {
  return value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
}

function finiteAxial(value) {
  return value
    && Number.isInteger(value.q)
    && Number.isInteger(value.r);
}

function axialDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

export function buildNeighborPreviewPlacements(regions, centerRegionId) {
  if (!Array.isArray(regions) || typeof centerRegionId !== "string") return [];
  const center = regions.find((entry) => entry?.id === centerRegionId);
  if (!center || !finiteOrigin(center.physicalOrigin) || !finiteOrigin(center.hexOrigin)) return [];

  return regions.flatMap((entry) => {
    if (
      !entry
      || entry.id === centerRegionId
      || typeof entry.id !== "string"
      || !finiteOrigin(entry.physicalOrigin)
      || !finiteOrigin(entry.hexOrigin)
    ) {
      return [];
    }
    return [{
      regionId: entry.id,
      axial: entry.axial,
      physicalOrigin: entry.physicalOrigin,
      hexOrigin: entry.hexOrigin,
      physicalOffset: {
        x: entry.physicalOrigin.x - center.physicalOrigin.x,
        z: entry.physicalOrigin.y - center.physicalOrigin.y,
      },
      hexOffset: {
        x: entry.hexOrigin.x - center.hexOrigin.x,
        z: entry.hexOrigin.y - center.hexOrigin.y,
      },
    }];
  });
}

/**
 * Return each loaded preview-to-preview seam exactly once. The center region is
 * not present in this list; it is already stitched through the primary terrain
 * mesh. Keeping this purely axial avoids relying on rendered floating-point
 * offsets when deciding which preview chunks really share a hex side.
 */
export function adjacentHexPreviewPairs(placements) {
  if (!Array.isArray(placements)) return [];
  const candidates = placements
    .filter((entry) => typeof entry?.regionId === "string" && finiteAxial(entry.axial))
    .sort((a, b) => a.regionId.localeCompare(b.regionId));
  const pairs = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const source = candidates[left];
      const target = candidates[right];
      if (axialDistance(source.axial, target.axial) === 1) pairs.push([source, target]);
    }
  }
  return pairs;
}

export function resolvePhysicalPreviewPlacement(
  placements,
  x,
  z,
  width,
  height,
  epsilon = 1e-6,
) {
  if (
    !Array.isArray(placements)
    || !Number.isFinite(x)
    || !Number.isFinite(z)
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
  ) {
    return null;
  }
  const halfWidth = width / 2 + Math.max(0, epsilon);
  const halfHeight = height / 2 + Math.max(0, epsilon);
  return placements.find((placement) =>
    Math.abs(x - placement.physicalOffset.x) <= halfWidth
      && Math.abs(z - placement.physicalOffset.z) <= halfHeight
  ) ?? null;
}
