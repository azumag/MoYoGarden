import { hexFootprintVertices, isPointInsideHexFootprint, regularHexFootprintSize } from "./hex-footprint.js";

const HEX_DIRECTIONS = ["east", "northEast", "northWest", "west", "southWest", "southEast"];
const HEX_STEPS = {
  east: { q: 1, r: 0 },
  northEast: { q: 1, r: -1 },
  northWest: { q: 0, r: -1 },
  west: { q: -1, r: 0 },
  southWest: { q: -1, r: 1 },
  southEast: { q: 0, r: 1 },
};
const HEX_SIDE_DIRECTIONS = [
  "northEast",
  "east",
  "southEast",
  "southWest",
  "west",
  "northWest",
];

export function resolveRegionRebase(regionLayout, centerRegionId, target) {
  if (!Array.isArray(regionLayout) || !centerRegionId || !target) return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return null;

  const center = regionLayout.find((entry) => entry?.id === centerRegionId);
  if (!validEntry(center)) return null;

  if (validHexPlacement(center)) {
    return resolveHexRegionRebase(regionLayout, center, target);
  }
  return resolvePhysicalRegionRebase(regionLayout, center, target);
}

function resolveHexRegionRebase(regionLayout, center, target) {
  if (isPointInsideHexFootprint(target.x, target.z, center.extent.width, center.extent.height)) {
    return null;
  }

  for (const entry of regionLayout) {
    if (entry?.id === center.id || !validEntry(entry) || !validHexPlacement(entry)) continue;
    if (validAxial(center) && validAxial(entry) && axialDistance(center.axial, entry.axial) !== 1) {
      continue;
    }

    const offsetX = entry.hexOrigin.x - center.hexOrigin.x;
    const offsetZ = entry.hexOrigin.y - center.hexOrigin.y;
    const localX = target.x - offsetX;
    const localZ = target.z - offsetZ;
    if (!isPointInsideHexFootprint(localX, localZ, entry.extent.width, entry.extent.height)) {
      continue;
    }
    return {
      regionId: entry.id,
      offsetX,
      offsetZ,
      target: { x: localX, z: localZ },
    };
  }

  return null;
}

function resolvePhysicalRegionRebase(regionLayout, center, target) {
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
    if (entry?.id === center.id || !validEntry(entry)) continue;
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

  const footprint = regularHexFootprintSize(center.extent.width, center.extent.height);
  const safeMargin = Number.isFinite(margin)
    ? Math.max(0, Math.min(footprint.radius, margin))
    : 0;
  if (safeMargin <= 0) return null;

  const direction = nearestHexBoundaryDirection(
    target,
    center.extent.width,
    center.extent.height,
    safeMargin,
  );
  if (direction === null) return null;

  const regionId = resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction);
  return regionId === null ? null : { regionId, direction };
}

function nearestHexBoundaryDirection(target, width, height, margin) {
  const vertices = hexFootprintVertices(width, height);
  let nearest = null;

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const edgeX = end.x - start.x;
    const edgeZ = end.z - start.z;
    const length = Math.hypot(edgeX, edgeZ);
    if (length <= 0) continue;

    let normalX = -edgeZ / length;
    let normalZ = edgeX / length;
    if ((-start.x) * normalX + (-start.z) * normalZ < 0) {
      normalX *= -1;
      normalZ *= -1;
    }
    const signedDistance =
      (target.x - start.x) * normalX + (target.z - start.z) * normalZ;
    if (nearest === null || signedDistance < nearest.distance) {
      nearest = {
        direction: HEX_SIDE_DIRECTIONS[index],
        distance: signedDistance,
      };
    }
  }

  return nearest !== null && nearest.distance <= margin ? nearest.direction : null;
}

function resolveLogicalHexNeighbor(regionLayout, centerRegionId, direction) {
  if (!HEX_DIRECTIONS.includes(direction)) return null;
  const entries = regionLayout.filter(validEntry);
  const centerIndex = entries.findIndex((entry) => entry.id === centerRegionId);
  if (centerIndex < 0) return null;

  const step = HEX_STEPS[direction];
  const center = entries[centerIndex];
  if (!step || !center) return null;

  if (validAxial(center)) {
    const targetKey = coordinateKey(center.axial.q + step.q, center.axial.r + step.r);
    const neighbor = entries.find(
      (entry) => validAxial(entry) && coordinateKey(entry.axial.q, entry.axial.r) === targetKey,
    );
    return neighbor?.id ?? null;
  }

  const coordinates = hexCoordinates(entries.length);
  const centerCoordinate = coordinates[centerIndex];
  if (!centerCoordinate) return null;

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

function axialDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

function validAxial(entry) {
  return Number.isInteger(entry?.axial?.q) && Number.isInteger(entry?.axial?.r);
}

function validHexPlacement(entry) {
  return Number.isFinite(entry?.hexOrigin?.x) && Number.isFinite(entry?.hexOrigin?.y);
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
