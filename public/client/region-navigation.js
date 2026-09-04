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

  // All six prewarm directions now resolve through the logical axial topology.
  // Physical rectangular origins remain a compatibility detail for camera rebase,
  // but they no longer decide which region is warmed ahead of movement.
  let direction;
  if (target.x >= halfWidth - safeMarginX) direction = "east";
  else if (target.x <= -halfWidth + safeMarginX) direction = "west";
  else if (target.z <= -halfHeight + safeMarginZ) {
    direction = target.x >= 0 ? "northEast" : "northWest";
  } else if (target.z >= halfHeight - safeMarginZ) {
    direction = target.x >= 0 ? "southEast" : "southWest";
  } else {
    return null;
  }

  const regionId = resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction);
  return regionId === null ? null : { regionId, direction };
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
