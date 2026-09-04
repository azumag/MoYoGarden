function finiteOrigin(value) {
  return value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
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
