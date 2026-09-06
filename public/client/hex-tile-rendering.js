import * as THREE from "three";
import {
  hexCellRadius,
  hexTileWorldXZ,
  isHexGridCell,
  worldXZToHexTile,
} from "./hex-grid.js";
import { regularHexFootprintSize } from "./hex-footprint.js";
import { TERRAIN_COLORS, disposeObject } from "./shared.js";
import { buildWeldedHexSurface } from "./terrain-stitch.js";
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

function buildSurfaceGeometry(surface) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(surface.colors, 3));
  geometry.setIndex(surface.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.userData.moyoWeldedHexSurface = true;
  return geometry;
}

function cloneSurfaceMaterial(material, fallback = null) {
  const source = Array.isArray(material) ? material[0] : material;
  const fallbackSource = Array.isArray(fallback) ? fallback[0] : fallback;
  const cloned = source?.clone?.()
    || fallbackSource?.clone?.()
    || new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.985,
      metalness: 0,
      envMapIntensity: 0.3,
    });
  cloned.vertexColors = true;
  cloned.needsUpdate = true;
  return cloned;
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

  const terrainEntries = [];
  const waterEntries = [];
  const surfaceHeights = new Map();
  const radius = hexCellRadius(state.width, state.height);

  for (const tile of state.tiles) {
    if (!isHexGridCell(tile, state.width, state.height)) continue;
    const center = hexTileWorldXZ(tile, state.width, state.height);
    const height = tileHeight(this, tile);
    const color = tileColor(tile);
    surfaceHeights.set(`${tile.x}:${tile.y}`, height);
    terrainEntries.push({ x: center.x, z: center.z, height, color });
    if (tile.terrain === "water") {
      waterEntries.push({ x: center.x, z: center.z, height: height + 0.04, color });
    }
  }
  this.surfaceHeightMap = surfaceHeights;

  const terrainSurface = buildWeldedHexSurface(terrainEntries, radius);
  const terrainGeometry = buildSurfaceGeometry(terrainSurface);
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
  this.terrainMesh.userData.moyoWeldedHexSurface = true;
  this.terrainMesh.receiveShadow = true;
  this.worldRoot.add(this.terrainMesh);

  if (waterEntries.length > 0) {
    const waterSurface = buildWeldedHexSurface(waterEntries, radius);
    const waterGeometry = buildSurfaceGeometry(waterSurface);
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
    this.waterMesh.userData.moyoWeldedHexSurface = true;
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

function previewSourceKind(source) {
  if (source?.geometry?.type === "BoxGeometry") return "land";
  if (source?.geometry?.type === "PlaneGeometry") return "water";
  return null;
}

function buildWeldedNeighborSurface(group, width, height, terrainFallbackMaterial) {
  const radius = hexCellRadius(width, height);
  const terrainEntries = [];
  const waterEntries = [];
  let landMaterial = null;
  let waterMaterial = null;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  for (const source of group.children.filter((entry) => entry?.isInstancedMesh)) {
    const kind = previewSourceKind(source);
    if (!kind) continue;
    if (kind === "land" && !landMaterial) landMaterial = source.material;
    if (kind === "water" && !waterMaterial) waterMaterial = source.material;
    const boxTopOffset = kind === "land"
      ? (Number(source.geometry?.parameters?.height) || 0.08) * 0.5
      : 0;

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
        : new THREE.Color(kind === "water" ? 0x39758a : 0x71845a);
      const renderedTop = matrix.elements[13] + boxTopOffset;
      const nativeTerrainHeight = kind === "water" ? renderedTop - 0.035 : renderedTop;
      terrainEntries.push({
        x: projected.x,
        z: projected.z,
        height: nativeTerrainHeight,
        color: entryColor,
      });
      if (kind === "water") {
        waterEntries.push({
          x: projected.x,
          z: projected.z,
          height: renderedTop,
          color: entryColor,
        });
      }
    }
  }

  const replacements = [];
  if (terrainEntries.length > 0) {
    const surface = buildWeldedHexSurface(terrainEntries, radius);
    const geometry = buildSurfaceGeometry(surface);
    const material = cloneSurfaceMaterial(landMaterial, terrainFallbackMaterial);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "neighbor-hex-land";
    mesh.userData.moyoWeldedHexSurface = true;
    mesh.receiveShadow = true;
    replacements.push(mesh);
  }

  if (waterEntries.length > 0) {
    const surface = buildWeldedHexSurface(waterEntries, radius);
    const geometry = buildSurfaceGeometry(surface);
    const material = cloneSurfaceMaterial(waterMaterial);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "neighbor-hex-water";
    mesh.userData.moyoWeldedHexSurface = true;
    mesh.renderOrder = 1;
    replacements.push(mesh);
  }
  return replacements;
}

function convertNeighborPreview(view) {
  const preview = view.worldRoot?.getObjectByName("neighbor-region-preview");
  if (!preview?.userData?.moyoHexChunked || preview.userData.moyoHexCells) return;
  const width = Number(view.state?.width);
  const height = Number(view.state?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;

  for (const group of preview.children.filter((entry) => entry?.isGroup)) {
    const sources = [...group.children].filter((entry) => entry?.isInstancedMesh && previewSourceKind(entry));
    const replacements = buildWeldedNeighborSurface(group, width, height, view.terrainMesh?.material);
    for (const source of sources) disposeObject(source);
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
