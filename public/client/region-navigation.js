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

export function resolveRegionPrefetch(regionLayout, centerRegionId, target, margin = 6) {
  if (!Array.isArray(regionLayout) || !centerRegionId || !target) return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return null;

  const center = regionLayout.find((entry) => entry?.id === centerRegionId);
  if (!validEntry(center)) return null;

  const halfWidth = center.extent.width / 2;
  const safeMargin = Number.isFinite(margin)
    ? Math.max(0, Math.min(halfWidth, margin))
    : 0;
  if (safeMargin <= 0) return null;

  const sameRow = regionLayout
    .filter((entry) => validEntry(entry) && entry.id !== centerRegionId)
    .filter((entry) => {
      const centerMinY = center.origin.y;
      const centerMaxY = center.origin.y + center.extent.height;
      const entryMinY = entry.origin.y;
      const entryMaxY = entry.origin.y + entry.extent.height;
      return entryMinY < centerMaxY && entryMaxY > centerMinY;
    });

  if (target.x >= halfWidth - safeMargin) {
    const east = sameRow
      .filter((entry) => entry.origin.x > center.origin.x)
      .sort((a, b) => a.origin.x - b.origin.x || a.id.localeCompare(b.id));
    const next = east[0];
    return next === undefined ? null : { regionId: next.id, direction: "east" };
  }

  if (target.x <= -halfWidth + safeMargin) {
    const west = sameRow
      .filter((entry) => entry.origin.x < center.origin.x)
      .sort((a, b) => b.origin.x - a.origin.x || a.id.localeCompare(b.id));
    const next = west[0];
    return next === undefined ? null : { regionId: next.id, direction: "west" };
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
