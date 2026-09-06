import { hexFootprintVertices } from "./hex-footprint.js";

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

function colorChannel(color, channel, fallback) {
  const value = Number(color?.[channel]);
  return Number.isFinite(value) ? value : fallback;
}

export function buildWeldedPreviewSurface(entries, resolveHeight) {
  const vertices = new Map();
  const indices = [];

  function vertexIndex(x, z, color) {
    const key = terrainVertexKey(x, z);
    let vertex = vertices.get(key);
    if (vertex === undefined) {
      const resolved = Number(resolveHeight?.(x, z));
      vertex = {
        index: vertices.size,
        x,
        y: Number.isFinite(resolved) ? resolved : 0,
        z,
        r: 0,
        g: 0,
        b: 0,
        samples: 0,
      };
      vertices.set(key, vertex);
    }
    vertex.r += colorChannel(color, "r", 0.44);
    vertex.g += colorChannel(color, "g", 0.52);
    vertex.b += colorChannel(color, "b", 0.35);
    vertex.samples += 1;
    return vertex.index;
  }

  for (const entry of entries ?? []) {
    if (!Number.isFinite(entry?.x) || !Number.isFinite(entry?.z)) continue;
    const corners = [
      [entry.x - 0.5, entry.z - 0.5],
      [entry.x + 0.5, entry.z - 0.5],
      [entry.x + 0.5, entry.z + 0.5],
      [entry.x - 0.5, entry.z + 0.5],
    ];
    const face = corners.map(([x, z]) => vertexIndex(x, z, entry.color));
    indices.push(face[0], face[2], face[1], face[0], face[3], face[2]);
  }

  const ordered = [...vertices.values()].sort((a, b) => a.index - b.index);
  const positions = [];
  const colors = [];
  for (const vertex of ordered) {
    positions.push(vertex.x, vertex.y, vertex.z);
    const samples = Math.max(1, vertex.samples);
    colors.push(vertex.r / samples, vertex.g / samples, vertex.b / samples);
  }

  return { positions, colors, indices, vertexCount: ordered.length };
}

function cross2(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

function projectToHexBoundary(x, z, width, height) {
  if (![x, z, width, height].every(Number.isFinite) || Math.hypot(x, z) <= 1e-12) {
    return { x, z };
  }
  const polygon = hexFootprintVertices(width, height);
  let bestT = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const denominator = cross2(x, z, ex, ez);
    if (Math.abs(denominator) <= 1e-12) continue;
    const t = cross2(a.x, a.z, ex, ez) / denominator;
    const u = cross2(a.x, a.z, x, z) / denominator;
    if (t <= 0 || u < -1e-9 || u > 1 + 1e-9) continue;
    bestT = Math.min(bestT, t);
  }
  if (!Number.isFinite(bestT)) return { x, z };
  return { x: x * bestT, z: z * bestT };
}

function conformBoundaryVertices(rawVertices, rawIndices, safeRadius, options) {
  const width = Number(options?.footprintWidth);
  const height = Number(options?.footprintHeight);
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return { vertices: rawVertices, indices: rawIndices };
  }

  const snapDistance = Number.isFinite(options?.boundarySnapDistance)
    ? Math.max(0, Number(options.boundarySnapDistance))
    : safeRadius * 1.35;
  const merged = new Map();
  const remap = new Map();

  for (const source of rawVertices) {
    let x = source.x;
    let z = source.z;
    if (source.cornerSamples > 0 && source.centerSamples === 0) {
      const projected = projectToHexBoundary(x, z, width, height);
      if (Math.hypot(projected.x - x, projected.z - z) <= snapDistance + 1e-9) {
        x = projected.x;
        z = projected.z;
      }
    }

    const key = terrainVertexKey(x, z);
    let target = merged.get(key);
    if (!target) {
      target = {
        index: merged.size,
        x,
        z,
        heightTotal: 0,
        heightSamples: 0,
        r: 0,
        g: 0,
        b: 0,
        colorSamples: 0,
        centerSamples: 0,
        cornerSamples: 0,
      };
      merged.set(key, target);
    }
    target.heightTotal += source.heightTotal;
    target.heightSamples += source.heightSamples;
    target.r += source.r;
    target.g += source.g;
    target.b += source.b;
    target.colorSamples += source.colorSamples;
    target.centerSamples += source.centerSamples;
    target.cornerSamples += source.cornerSamples;
    remap.set(source.index, target.index);
  }

  return {
    vertices: [...merged.values()].sort((a, b) => a.index - b.index),
    indices: rawIndices.map((index) => remap.get(index) ?? index),
  };
}

/**
 * Build a smooth hex-cell surface and, when a region footprint is supplied,
 * conform only the outer cell-corner ring to the exact macro-hex boundary.
 * This gives neighboring regions real shared world-space vertices instead of
 * relying on GPU clipping to manufacture two independent seam edges.
 */
export function buildWeldedHexSurface(entries, radius, options = undefined) {
  const safeRadius = Number(radius);
  if (!Number.isFinite(safeRadius) || safeRadius <= 0) {
    return { positions: [], colors: [], indices: [], vertexCount: 0 };
  }

  const vertices = new Map();
  const indices = [];

  function vertexIndex(x, z, height, color, corner) {
    const key = terrainVertexKey(x, z);
    let vertex = vertices.get(key);
    if (vertex === undefined) {
      vertex = {
        index: vertices.size,
        x,
        z,
        heightTotal: 0,
        heightSamples: 0,
        r: 0,
        g: 0,
        b: 0,
        colorSamples: 0,
        centerSamples: 0,
        cornerSamples: 0,
      };
      vertices.set(key, vertex);
    }
    const numericHeight = Number(height);
    if (Number.isFinite(numericHeight)) {
      vertex.heightTotal += numericHeight;
      vertex.heightSamples += 1;
    }
    vertex.r += colorChannel(color, "r", 0.44);
    vertex.g += colorChannel(color, "g", 0.52);
    vertex.b += colorChannel(color, "b", 0.35);
    vertex.colorSamples += 1;
    if (corner) vertex.cornerSamples += 1;
    else vertex.centerSamples += 1;
    return vertex.index;
  }

  for (const entry of entries ?? []) {
    const x = Number(entry?.x);
    const z = Number(entry?.z);
    const height = Number(entry?.height);
    if (![x, z, height].every(Number.isFinite)) continue;

    const center = vertexIndex(x, z, height, entry.color, false);
    const corners = [];
    for (let index = 0; index < 6; index += 1) {
      const angle = index * Math.PI / 3;
      corners.push(vertexIndex(
        x + Math.cos(angle) * safeRadius,
        z + Math.sin(angle) * safeRadius,
        height,
        entry.color,
        true,
      ));
    }
    for (let index = 0; index < 6; index += 1) {
      indices.push(center, corners[(index + 1) % 6], corners[index]);
    }
  }

  const rawVertices = [...vertices.values()].sort((a, b) => a.index - b.index);
  const conformed = conformBoundaryVertices(rawVertices, indices, safeRadius, options);
  const positions = [];
  const colors = [];
  for (const vertex of conformed.vertices) {
    const heightSamples = Math.max(1, vertex.heightSamples);
    const colorSamples = Math.max(1, vertex.colorSamples);
    positions.push(vertex.x, vertex.heightTotal / heightSamples, vertex.z);
    colors.push(
      vertex.r / colorSamples,
      vertex.g / colorSamples,
      vertex.b / colorSamples,
    );
  }

  return {
    positions,
    colors,
    indices: conformed.indices,
    vertexCount: conformed.vertices.length,
  };
}
