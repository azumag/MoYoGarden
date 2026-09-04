import * as THREE from "three";
import {
  hexCellRadius,
  hexTileWorldXZ,
  isHexGridCell,
  worldXZToHexTile,
} from "./hex-grid.js";
import { regularHexFootprintSize } from "./hex-footprint.js";
import { TERRAIN_COLORS, disposeObject } from "./shared.js";
import { WorldView } from "./world-view.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function tileHeight(view, tile) {
  if (!tile || tile.terrain === "water") return -0.24;
  if (Number.isFinite(tile.elevation)) {
    return 0.015 + Math.pow(clamp01(tile.elevation), 1.18) * 0.82;
  }
  return view.terrainHeight(tile);
}

function tileColor(tile) {
  const color = (TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain).clone();
  const elevation = Number.isFinite(tile.elevation) ? tile.elevation : 0.5;
  const drainage = Number.isFinite(tile.drainage) ? clamp01(tile.drainage) : 0;
  if (tile.terrain !== "water") {
    color.offsetHSL(0, 0, (elevation - 0.5) * 0.055 + drainage * 0.025);
  }
  return color;
}

function appendHexFace(positions, colors, indices, center, y, radius, color) {
  const base = positions.length / 3;
  positions.push(center.x, y, center.z);
  colors.push(color.r, color.g, color.b);
  for (let index = 0; index < 6; index += 1) {
    const angle = index * Math.PI / 3;
    positions.push(
      center.x + Math.cos(angle) * radius,
      y,
      center.z + Math.sin(angle) * radius,
    );
    colors.push(color.r, color.g, color.b);
  }
  for (let index = 0; index < 6; index += 1) {
    indices.push(base, base + 1 + index, base + 1 + ((index + 1) % 6));
  }
}

function buildFaceGeometry(positions, colors, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

WorldView.prototype.worldPosition = function worldPositionHex(position, lift = 0) {
  const tile = this.tileAt(position.x, position.y);
  const surfaceHeight = this.surfaceHeightMap.get(`${position.x}:${position.y}`);
  const projected = hexTileWorldXZ(position, this.state.width, this.state.height);
  return new THREE.Vector3(
    projected.x,
    (surfaceHeight ?? tileHeight(this, tile)) + lift,
    projected.z,
  );
};

WorldView.prototype.pickTile = function pickHexTile(event) {
  if (!this.terrainMesh || !this.state) return null;
  this.pointerNdc(event);
  this.raycaster.setFromCamera(this.pointer, this.camera);
  const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
  if (!hit) return null;
  const position = worldXZToHexTile(hit.point.x, hit.point.z, this.state.width, this.state.height);
  if (!position) return null;
  const tile = this.tileAt(position.x, position.y);
  return tile && tile.terrain !== "water" ? position : null;
};

WorldView.prototype.buildTerrain = function buildHexTerrain(state) {
  disposeObject(this.terrainMesh);
  disposeObject(this.waterMesh);
  disposeObject(this.detailRoot);

  const landPositions = [];
  const landColors = [];
  const landIndices = [];
  const waterPositions = [];
  const waterColors = [];
  const waterIndices = [];
  const surfaceHeights = new Map();
  const radius = hexCellRadius(state.width, state.height) * 0.985;

  for (const tile of state.tiles) {
    if (!isHexGridCell(tile, state.width, state.height)) continue;
    const center = hexTileWorldXZ(tile, state.width, state.height);
    const y = tileHeight(this, tile);
    surfaceHeights.set(`${tile.x}:${tile.y}`, y);
    if (tile.terrain === "water") {
      appendHexFace(waterPositions, waterColors, waterIndices, center, y + 0.04, radius, tileColor(tile));
    } else {
      appendHexFace(landPositions, landColors, landIndices, center, y, radius, tileColor(tile));
    }
  }
  this.surfaceHeightMap = surfaceHeights;

  const terrainGeometry = buildFaceGeometry(landPositions, landColors, landIndices);
  this.terrainMesh = new THREE.Mesh(
    terrainGeometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.985,
      metalness: 0,
      envMapIntensity: 0.3,
    }),
  );
  this.terrainMesh.name = "hex-cell-terrain";
  this.terrainMesh.receiveShadow = true;
  this.worldRoot.add(this.terrainMesh);

  if (waterPositions.length > 0) {
    const waterGeometry = buildFaceGeometry(waterPositions, waterColors, waterIndices);
    this.waterMesh = new THREE.Mesh(
      waterGeometry,
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.2,
        metalness: 0.03,
        transparent: true,
        opacity: 0.73,
        depthWrite: false,
        clearcoat: 0.82,
        clearcoatRoughness: 0.24,
        envMapIntensity: 1.02,
      }),
    );
    this.waterMesh.name = "hex-cell-water";
    this.waterMesh.renderOrder = 2;
    this.worldRoot.add(this.waterMesh);
  }

  const detail = new THREE.Group();
  detail.name = "hex-cell-underlay";
  const footprint = regularHexFootprintSize(state.width, state.height);
  const underlay = new THREE.Mesh(
    new THREE.BoxGeometry(footprint.width, 0.5, footprint.height),
    new THREE.MeshStandardMaterial({
      color: 0x5d5c4f,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.12,
    }),
  );
  underlay.position.y = -0.82;
  underlay.receiveShadow = true;
  detail.add(underlay);
  this.detailRoot = detail;
  this.worldRoot.add(detail);
};

function convertedGeometry(source, radius) {
  if (source.geometry?.type === "BoxGeometry") {
    const geometry = new THREE.CylinderGeometry(radius, radius, 0.08, 6);
    geometry.rotateY(Math.PI / 6);
    return { geometry, water: false };
  }
  if (source.geometry?.type === "PlaneGeometry") {
    const geometry = new THREE.CircleGeometry(radius, 6);
    geometry.rotateX(-Math.PI / 2);
    geometry.rotateZ(Math.PI / 6);
    return { geometry, water: true };
  }
  return null;
}

function convertNeighborChunkMesh(source, width, height) {
  const radius = hexCellRadius(width, height) * 0.985;
  const converted = convertedGeometry(source, radius);
  if (!converted) return null;

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const entries = [];
  for (let index = 0; index < source.count; index += 1) {
    source.getMatrixAt(index, matrix);
    const tile = {
      x: Math.round(matrix.elements[12] + width / 2 - 0.5),
      y: Math.round(matrix.elements[14] + height / 2 - 0.5),
    };
    if (!isHexGridCell(tile, width, height)) continue;
    const projected = hexTileWorldXZ(tile, width, height);
    const entryColor = source.instanceColor
      ? (source.getColorAt(index, color), color.clone())
      : new THREE.Color(0x71845a);
    entries.push({ x: projected.x, y: matrix.elements[13], z: projected.z, color: entryColor });
  }
  if (entries.length === 0) {
    converted.geometry.dispose();
    return null;
  }

  const material = Array.isArray(source.material)
    ? source.material.map((entry) => entry.clone())
    : source.material.clone();
  const mesh = new THREE.InstancedMesh(converted.geometry, material, entries.length);
  mesh.name = converted.water ? "neighbor-hex-water" : "neighbor-hex-land";
  mesh.receiveShadow = source.receiveShadow;
  mesh.renderOrder = source.renderOrder;
  entries.forEach((entry, index) => {
    matrix.identity();
    matrix.setPosition(entry.x, entry.y, entry.z);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, entry.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function convertNeighborPreview(view) {
  const preview = view.worldRoot?.getObjectByName("neighbor-region-preview");
  if (!preview?.userData?.moyoHexChunked || preview.userData.moyoHexCells) return;
  const width = Number(view.state?.width);
  const height = Number(view.state?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;

  for (const group of preview.children.filter((entry) => entry?.isGroup)) {
    const replacements = [];
    for (const source of [...group.children]) {
      if (!source?.isInstancedMesh) continue;
      const replacement = convertNeighborChunkMesh(source, width, height);
      if (replacement) replacements.push(replacement);
      disposeObject(source);
    }
    group.add(...replacements);
  }
  preview.userData.moyoHexCells = true;
  view.__moyoNavigationPreview = undefined;
}

const previousMarkShadowsDirty = WorldView.prototype.markShadowsDirty;
WorldView.prototype.markShadowsDirty = function markShadowsDirtyWithHexCells() {
  previousMarkShadowsDirty.call(this);
  convertNeighborPreview(this);
};
