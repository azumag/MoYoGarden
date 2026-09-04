const HEX_DIRECTIONS = ["east", "northEast", "northWest", "west", "southWest", "southEast"];
const HEX_STEPS = {
  east: { q: 1, r: 0 },
  northEast: { q: 1, r: -1 },
  northWest: { q: 0, r: -1 },
  west: { q: -1, r: 0 },
  southWest: { q: -1, r: 1 },
  southEast: { q: 0, r: 1 },
};

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
  const halfHeight = center.extent.height / 2;
  const safeMarginX = Number.isFinite(margin)
    ? Math.max(0, Math.min(halfWidth, margin))
    : 0;
  const safeMarginZ = Number.isFinite(margin)
    ? Math.max(0, Math.min(halfHeight, margin))
    : 0;
  if (safeMarginX <= 0 || safeMarginZ <= 0) return null;

  const sameRow = regionLayout
    .filter((entry) => validEntry(entry) && entry.id !== centerRegionId)
    .filter((entry) => {
      const centerMinY = center.origin.y;
      const centerMaxY = center.origin.y + center.extent.height;
      const entryMinY = entry.origin.y;
      const entryMaxY = entry.origin.y + entry.extent.height;
      return entryMinY < centerMaxY && entryMaxY > centerMinY;
    });

  // Keep the existing physical east/west handoff warm while the stored regions are
  // still laid out as rectangles. The four diagonal directions below use the new
  // logical hex topology and can become physical handoff directions independently.
  if (target.x >= halfWidth - safeMarginX) {
    const east = sameRow
      .filter((entry) => entry.origin.x > center.origin.x)
      .sort((a, b) => a.origin.x - b.origin.x || a.id.localeCompare(b.id));
    const next = east[0];
    return next === undefined ? null : { regionId: next.id, direction: "east" };
  }

  if (target.x <= -halfWidth + safeMarginX) {
    const west = sameRow
      .filter((entry) => entry.origin.x < center.origin.x)
      .sort((a, b) => b.origin.x - a.origin.x || a.id.localeCompare(b.id));
    const next = west[0];
    return next === undefined ? null : { regionId: next.id, direction: "west" };
  }

  if (target.z <= -halfHeight + safeMarginZ) {
    const direction = target.x >= 0 ? "northEast" : "northWest";
    const regionId = resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction);
    return regionId === null ? null : { regionId, direction };
  }

  if (target.z >= halfHeight - safeMarginZ) {
    const direction = target.x >= 0 ? "southEast" : "southWest";
    const regionId = resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction);
    return regionId === null ? null : { regionId, direction };
  }

  return null;
}

function resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction) {
  if (!HEX_DIRECTIONS.includes(direction)) return null;
  const entries = regionLayout.filter(validEntry);
  const centerIndex = entries.findIndex((entry) => entry.id === centerRegionId);
  if (centerIndex < 0) return null;

  const coordinates = hexCoordinates(entries.length);
  const centerCoordinate = coordinates[centerIndex];
  const step = HEX_STEPS[direction];
  if (!centerCoordinate || !step) return null;

  const targetKey = coordinateKey(centerCoordinate.q + step.q, centerCoordinate.r + step.r);
  for (let index = 0; index < entries.length; index += 1) {
    const coordinate = coordinates[index];
    if (coordinate && coordinateKey(coordinate.q, coordinate.r) === targetKey) {
      return entries[index]?.id ?? null;
    }
  }
  return null;
}

function hexCoordinates(count) {
  const coordinates = [];
  const queue = [{ q: 0, r: 0 }];
  const seen = new Set([coordinateKey(0, 0)]);

  while (coordinates.length < count) {
    const coordinate = queue.shift();
    if (!coordinate) break;
    coordinates.push(coordinate);
    for (const direction of HEX_DIRECTIONS) {
      const step = HEX_STEPS[direction];
      const next = { q: coordinate.q + step.q, r: coordinate.r + step.r };
      const key = coordinateKey(next.q, next.r);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return coordinates;
}

function coordinateKey(q, r) {
  return `${q},${r}`;
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
