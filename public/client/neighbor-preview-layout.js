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

const HEX_AXIAL_STEPS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

function axialKey(q, r) {
  return `${q},${r}`;
}

function originKey(origin) {
  return `${origin.x},${origin.y}`;
}

export function buildNeighborPreviewPlacements(regions, centerRegionId) {
  if (!Array.isArray(regions) || typeof centerRegionId !== "string") return [];

  // Hex preview placement is an all-or-nothing topology contract. Rendering a
  // partially described region can leave it unstitched, while two distinct
  // region IDs claiming the same axial/origin slot can put whole preview chunks
  // on top of each other. Keep the legacy rectangular preview intact instead of
  // upgrading from ambiguous metadata during rolling deploys or partial reads.
  const seenRegionIds = new Set();
  const seenAxial = new Set();
  const seenPhysicalOrigins = new Set();
  const seenHexOrigins = new Set();
  for (const entry of regions) {
    if (
      !entry
      || typeof entry.id !== "string"
      || entry.id.length === 0
      || !finiteAxial(entry.axial)
      || !finiteOrigin(entry.physicalOrigin)
      || !finiteOrigin(entry.hexOrigin)
    ) return [];

    const axial = axialKey(entry.axial.q, entry.axial.r);
    const physicalOrigin = originKey(entry.physicalOrigin);
    const hexOrigin = originKey(entry.hexOrigin);
    if (
      seenRegionIds.has(entry.id)
      || seenAxial.has(axial)
      || seenPhysicalOrigins.has(physicalOrigin)
      || seenHexOrigins.has(hexOrigin)
    ) return [];
    seenRegionIds.add(entry.id);
    seenAxial.add(axial);
    seenPhysicalOrigins.add(physicalOrigin);
    seenHexOrigins.add(hexOrigin);
  }

  const center = regions.find((entry) => entry.id === centerRegionId);
  if (!center) return [];

  return regions.flatMap((entry) => {
    if (entry.id === centerRegionId) return [];
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
 *
 * Indexing the loaded chunks by axial coordinate keeps seam discovery linear
 * in the number of preview regions instead of comparing every pair. This
 * matters once far-terrain windows grow beyond the immediate six neighbors.
 */
export function adjacentHexPreviewPairs(placements) {
  if (!Array.isArray(placements)) return [];
  const candidates = placements
    .flatMap((entry) => {
      const axial = entry?.axial;
      if (typeof entry?.regionId !== "string" || !finiteAxial(axial)) return [];
      return [{ entry, q: axial.q, r: axial.r }];
    })
    .sort((a, b) => a.entry.regionId.localeCompare(b.entry.regionId))
    .map((candidate, order) => ({ ...candidate, order }));

  const byAxial = new Map();
  for (const candidate of candidates) {
    const key = axialKey(candidate.q, candidate.r);
    const bucket = byAxial.get(key);
    if (bucket) bucket.push(candidate);
    else byAxial.set(key, [candidate]);
  }

  const pairs = [];
  for (const source of candidates) {
    const targets = [];
    for (const [dq, dr] of HEX_AXIAL_STEPS) {
      const bucket = byAxial.get(axialKey(source.q + dq, source.r + dr));
      if (!bucket) continue;
      for (const target of bucket) {
        if (target.order > source.order) targets.push(target);
      }
    }
    targets.sort((a, b) => a.order - b.order);
    for (const target of targets) pairs.push([source.entry, target.entry]);
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
