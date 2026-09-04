import { regularHexFootprintSize } from "./hex-footprint.js";

const SQRT_THREE = Math.sqrt(3);

export const HEX_GRID_STEPS = Object.freeze([
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 1, y: -1 }),
  Object.freeze({ x: 0, y: -1 }),
  Object.freeze({ x: -1, y: 0 }),
  Object.freeze({ x: -1, y: 1 }),
  Object.freeze({ x: 0, y: 1 }),
]);

export function hexGridDistance(a, b) {
  const dq = a.x - b.x;
  const dr = a.y - b.y;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

export function hexGridCenter(width, height) {
  return {
    x: Math.floor((width - 1) / 2),
    y: Math.floor((height - 1) / 2),
  };
}

export function hexGridRadius(width, height) {
  const center = hexGridCenter(width, height);
  return Math.max(1, Math.min(
    center.x,
    width - 1 - center.x,
    center.y,
    height - 1 - center.y,
  ));
}

export function isHexGridCell(position, width, height) {
  if (
    !Number.isInteger(position?.x) ||
    !Number.isInteger(position?.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x >= width ||
    position.y >= height
  ) return false;
  return hexGridDistance(position, hexGridCenter(width, height)) <= hexGridRadius(width, height);
}

export function hexCellRadius(width, height) {
  const region = regularHexFootprintSize(width, height);
  const radius = hexGridRadius(width, height);
  return region.width / Math.max(2, 3 * radius + 2);
}

export function hexTileWorldXZ(position, width, height) {
  const center = hexGridCenter(width, height);
  const cellRadius = hexCellRadius(width, height);
  const q = position.x - center.x;
  const r = position.y - center.y;
  return {
    x: cellRadius * 1.5 * q,
    z: cellRadius * SQRT_THREE * (r + q * 0.5),
  };
}

export function hexCellVertices(position, width, height, scale = 1) {
  const center = hexTileWorldXZ(position, width, height);
  const radius = hexCellRadius(width, height) * scale;
  return Array.from({ length: 6 }, (_, index) => {
    const angle = index * Math.PI / 3;
    return {
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius,
    };
  });
}

function cubeRound(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

export function worldXZToHexTile(x, z, width, height) {
  const size = hexCellRadius(width, height);
  if (!Number.isFinite(x) || !Number.isFinite(z) || size <= 0) return null;
  const fractionalQ = (2 / 3 * x) / size;
  const fractionalR = (-x / 3 + SQRT_THREE / 3 * z) / size;
  const axial = cubeRound(fractionalQ, fractionalR);
  const center = hexGridCenter(width, height);
  const position = { x: center.x + axial.q, y: center.y + axial.r };
  return isHexGridCell(position, width, height) ? position : null;
}
