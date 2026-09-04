export function resolveRegionRebase(regionLayout, centerRegionId, target) {
  if (!Array.isArray(regionLayout) || !centerRegionId || !target) return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return null;

  const center = regionLayout.find((entry) => entry?.id === centerRegionId);
  if (!validEntry(center)) return null;

  const centerHalfWidth = center.extent.width / 2;
  const centerHalfHeight = center.extent.height / 2;
  const centerBounds = {
    minX: -centerHalfWidth,
    maxX: centerHalfWidth,
    minZ: -centerHalfHeight,
    maxZ: centerHalfHeight,
  };
  if (contains(centerBounds, target)) return null;

  for (const entry of regionLayout) {
    if (entry?.id === centerRegionId || !validEntry(entry)) continue;
    const offsetX = entry.origin.x - center.origin.x;
    const offsetZ = entry.origin.y - center.origin.y;
    const bounds = {
      minX: offsetX - centerHalfWidth,
      maxX: offsetX - centerHalfWidth + entry.extent.width,
      minZ: offsetZ - centerHalfHeight,
      maxZ: offsetZ - centerHalfHeight + entry.extent.height,
    };
    if (!contains(bounds, target)) continue;
    return {
      regionId: entry.id,
      offsetX,
      offsetZ,
      target: {
        x: target.x - offsetX,
        z: target.z - offsetZ,
      },
    };
  }

  return null;
}

function validEntry(entry) {
  return Boolean(
    entry?.id
      && Number.isFinite(entry.origin?.x)
      && Number.isFinite(entry.origin?.y)
      && Number.isFinite(entry.extent?.width)
      && entry.extent.width > 0
      && Number.isFinite(entry.extent?.height)
      && entry.extent.height > 0,
  );
}

function contains(bounds, target) {
  return target.x >= bounds.minX
    && target.x < bounds.maxX
    && target.z >= bounds.minZ
    && target.z < bounds.maxZ;
}
