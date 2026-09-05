import * as THREE from "three";
import { isHexGridCell } from "./hex-grid.js";
import { hash2, setShadows } from "./shared.js";
import { WorldView } from "./world-view.js";

function sharedGeometry(geometry) {
  geometry.userData.moyoShared = true;
  return geometry;
}

function sharedMaterial(options) {
  const material = new THREE.MeshStandardMaterial(options);
  material.userData.moyoShared = true;
  return material;
}

const DECAY_GEOMETRY = Object.freeze({
  deadwood: sharedGeometry(new THREE.CylinderGeometry(0.04, 0.065, 0.78, 7)),
  rubble: sharedGeometry(new THREE.DodecahedronGeometry(0.11, 0)),
  mud: sharedGeometry(new THREE.CircleGeometry(0.28, 14)),
  plank: sharedGeometry(new THREE.BoxGeometry(0.68, 0.055, 0.075)),
  brace: sharedGeometry(new THREE.BoxGeometry(0.78, 0.05, 0.065)),
  patch: sharedGeometry(new THREE.BoxGeometry(0.44, 0.026, 0.29)),
});

const DECAY_MATERIAL = Object.freeze({
  deadwood: sharedMaterial({
    color: 0x49382b,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.08,
  }),
  rubble: sharedMaterial({
    color: 0x56534b,
    roughness: 0.99,
    metalness: 0.015,
    envMapIntensity: 0.12,
  }),
  mud: sharedMaterial({
    color: 0x403d36,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.04,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  }),
  rottenWood: sharedMaterial({
    color: 0x403126,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.1,
  }),
  rust: sharedMaterial({
    color: 0x5c3e31,
    roughness: 0.93,
    metalness: 0.18,
    envMapIntensity: 0.16,
  }),
  soot: sharedMaterial({
    color: 0x2d2e2a,
    roughness: 0.98,
    metalness: 0.01,
    envMapIntensity: 0.06,
  }),
});

function tileAt(state, x, y) {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  const tile = state.tiles[y * state.width + x] || null;
  return isHexGridCell(tile, state.width, state.height) ? tile : null;
}

function wetnessHint(state, tile) {
  if (!tile || tile.terrain === "water") return 1;
  let waterInfluence = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance === 0 || distance > 2) continue;
      if (tileAt(state, tile.x + dx, tile.y + dy)?.terrain !== "water") continue;
      waterInfluence = Math.max(waterInfluence, (3 - distance) / 2);
    }
  }
  const drainage = Number.isFinite(tile.drainage)
    ? Math.max(0, Math.min(1, tile.drainage))
    : 0;
  return Math.min(1, waterInfluence * 0.72 + drainage * 0.42);
}

function nearSettlement(state, tile, radius = 2.2) {
  const radiusSq = radius * radius;
  return state.structures.some((structure) => {
    const dx = structure.position.x - tile.x;
    const dy = structure.position.y - tile.y;
    return dx * dx + dy * dy <= radiusSq;
  });
}

function setStaticInstances(mesh, entries, makeMatrix) {
  entries.forEach((entry, index) => mesh.setMatrixAt(index, makeMatrix(entry, index)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.computeBoundingSphere();
}

function addTerrainDecay(view, state) {
  if (!view.detailRoot || !state?.tiles?.length) return;
  const density = view.quality?.detailDensity ?? 0.62;
  const castMicroShadows = view.quality?.id !== "balanced";
  const renderableTiles = state.tiles.filter((tile) => isHexGridCell(tile, state.width, state.height));
  const group = new THREE.Group();
  group.name = "MoyoDecayDressing";

  const deadwoodTiles = renderableTiles.filter((tile) => (
    tile.terrain !== "water"
    && !nearSettlement(state, tile)
    && (tile.terrain === "forest" || tile.resource?.kind === "wood")
    && hash2(tile.x, tile.y, 910) > 0.982 - density * 0.022
  ));
  if (deadwoodTiles.length > 0) {
    const deadwood = new THREE.InstancedMesh(
      DECAY_GEOMETRY.deadwood,
      DECAY_MATERIAL.deadwood,
      deadwoodTiles.length,
    );
    deadwood.name = "MoyoDecayDeadwood";
    setStaticInstances(deadwood, deadwoodTiles, (tile) => {
      const position = view.worldPosition(tile, 0.045);
      position.x += (hash2(tile.x, tile.y, 911) - 0.5) * 0.52;
      position.z += (hash2(tile.x, tile.y, 912) - 0.5) * 0.52;
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (hash2(tile.x, tile.y, 913) - 0.5) * 0.18,
        hash2(tile.x, tile.y, 914) * Math.PI,
        Math.PI / 2 + (hash2(tile.x, tile.y, 915) - 0.5) * 0.16,
      ));
      const scale = new THREE.Vector3(
        0.72 + hash2(tile.x, tile.y, 916) * 0.5,
        0.76 + hash2(tile.x, tile.y, 917) * 0.68,
        0.72 + hash2(tile.x, tile.y, 918) * 0.5,
      );
      return new THREE.Matrix4().compose(position, rotation, scale);
    });
    deadwood.castShadow = castMicroShadows;
    deadwood.receiveShadow = true;
    group.add(deadwood);
  }

  const naturalRubble = renderableTiles.filter((tile) => (
    tile.terrain === "hill"
    && !tile.resource
    && hash2(tile.x, tile.y, 920) > 0.985 - density * 0.018
  ));
  const settlementRubble = [];
  const piecesPerStructure = density >= 0.8 ? 2 : 1;
  for (const structure of state.structures) {
    for (let index = 0; index < piecesPerStructure; index += 1) {
      settlementRubble.push({ structure, index });
    }
  }
  const rubbleCount = naturalRubble.length + settlementRubble.length;
  if (rubbleCount > 0) {
    const rubble = new THREE.InstancedMesh(
      DECAY_GEOMETRY.rubble,
      DECAY_MATERIAL.rubble,
      rubbleCount,
    );
    rubble.name = "MoyoDecayRubble";
    let cursor = 0;
    for (const tile of naturalRubble) {
      const position = view.worldPosition(tile, 0.07);
      position.x += (hash2(tile.x, tile.y, 921) - 0.5) * 0.55;
      position.z += (hash2(tile.x, tile.y, 922) - 0.5) * 0.55;
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        hash2(tile.x, tile.y, 923) * 0.6,
        hash2(tile.x, tile.y, 924) * Math.PI,
        hash2(tile.x, tile.y, 925) * 0.5,
      ));
      const scale = new THREE.Vector3(
        0.6 + hash2(tile.x, tile.y, 926) * 0.9,
        0.42 + hash2(tile.x, tile.y, 927) * 0.7,
        0.7 + hash2(tile.x, tile.y, 928) * 0.8,
      );
      rubble.setMatrixAt(cursor, new THREE.Matrix4().compose(position, rotation, scale));
      cursor += 1;
    }
    for (const { structure, index } of settlementRubble) {
      const seed = 940 + index * 7;
      const position = view.worldPosition(structure.position, 0.075);
      const angle = hash2(structure.position.x, structure.position.y, seed) * Math.PI * 2;
      const radius = 0.82 + hash2(structure.position.x, structure.position.y, seed + 1) * 0.55;
      position.x += Math.cos(angle) * radius;
      position.z += Math.sin(angle) * radius;
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        hash2(structure.position.x, structure.position.y, seed + 2) * 0.65,
        angle,
        hash2(structure.position.x, structure.position.y, seed + 3) * 0.5,
      ));
      const scale = new THREE.Vector3(
        0.72 + hash2(structure.position.x, structure.position.y, seed + 4) * 0.9,
        0.48 + hash2(structure.position.x, structure.position.y, seed + 5) * 0.62,
        0.72 + hash2(structure.position.x, structure.position.y, seed + 6) * 0.9,
      );
      rubble.setMatrixAt(cursor, new THREE.Matrix4().compose(position, rotation, scale));
      cursor += 1;
    }
    rubble.instanceMatrix.needsUpdate = true;
    rubble.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    rubble.computeBoundingSphere();
    rubble.castShadow = castMicroShadows;
    rubble.receiveShadow = true;
    group.add(rubble);
  }

  const mudTiles = renderableTiles.filter((tile) => (
    tile.terrain !== "water"
    && !nearSettlement(state, tile, 1.05)
    && wetnessHint(state, tile) >= 0.38
    && hash2(tile.x, tile.y, 960) > 0.97 - density * 0.02
  ));
  if (mudTiles.length > 0) {
    const mud = new THREE.InstancedMesh(
      DECAY_GEOMETRY.mud,
      DECAY_MATERIAL.mud,
      mudTiles.length,
    );
    mud.name = "MoyoDecayMudPatch";
    setStaticInstances(mud, mudTiles, (tile) => {
      const position = view.worldPosition(tile, 0.018);
      position.x += (hash2(tile.x, tile.y, 961) - 0.5) * 0.38;
      position.z += (hash2(tile.x, tile.y, 962) - 0.5) * 0.38;
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      const scale = new THREE.Vector3(
        0.72 + hash2(tile.x, tile.y, 963) * 0.82,
        0.72 + hash2(tile.x, tile.y, 964) * 0.82,
        1,
      );
      return new THREE.Matrix4().compose(position, rotation, scale);
    });
    mud.receiveShadow = false;
    mud.renderOrder = 1;
    group.add(mud);
  }

  view.detailRoot.add(group);
}

function addDecayPart(group, geometry, material, position, rotation, name, scale = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  if (scale) mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function decorateStructureDecay(root, structure, detail) {
  if (!root || root.getObjectByName("MoyoDecayArchitecture")) return;
  const seed = hash2(structure.position.x, structure.position.y, 980);
  const group = new THREE.Group();
  group.name = "MoyoDecayArchitecture";

  const roofHeight = structure.type === "market" ? 1.46
    : structure.type === "camp" ? 1.06
      : structure.type === "workshop" ? 1.38 : 1.32;
  const frontZ = structure.type === "market" ? 0.51 : 0.5;

  addDecayPart(
    group,
    DECAY_GEOMETRY.plank,
    DECAY_MATERIAL.rottenWood,
    [-0.1 + (seed - 0.5) * 0.34, 0.58 + seed * 0.18, frontZ + 0.055],
    [0.04, (seed - 0.5) * 0.16, -0.42 + seed * 0.74],
    "MoyoBrokenPlank",
    [0.82 + seed * 0.34, 1, 1],
  );

  addDecayPart(
    group,
    DECAY_GEOMETRY.patch,
    DECAY_MATERIAL.rust,
    [0.34 - seed * 0.42, roofHeight, -0.08 + seed * 0.24],
    [0.04 + seed * 0.12, seed * 0.32, -0.05 + seed * 0.1],
    "MoyoRustPatch",
    [0.82 + seed * 0.35, 1, 0.8 + (1 - seed) * 0.42],
  );

  if (detail === "high") {
    addDecayPart(
      group,
      DECAY_GEOMETRY.brace,
      DECAY_MATERIAL.soot,
      [-0.58, 0.58, -0.48],
      [0, 0.1 + seed * 0.2, 0.58 - seed * 0.22],
      "MoyoCollapsedBrace",
      [0.9 + seed * 0.28, 1, 1],
    );
    addDecayPart(
      group,
      DECAY_GEOMETRY.plank,
      DECAY_MATERIAL.rottenWood,
      [0.48, 0.25 + seed * 0.16, -0.57],
      [0.03, -0.18 + seed * 0.36, 0.12 - seed * 0.32],
      "MoyoLoosePlank",
      [0.62 + seed * 0.28, 0.9, 0.9],
    );
  }

  root.add(group);
  setShadows(group, true, true);
}

const originalBuildTerrain = WorldView.prototype.buildTerrain;
WorldView.prototype.buildTerrain = function buildTerrainWithDecayDressing(state) {
  originalBuildTerrain.call(this, state);
  addTerrainDecay(this, state);
};

const originalCreateStructure = WorldView.prototype.createStructure;
WorldView.prototype.createStructure = function createStructureWithDecayDressing(structure, faction, state) {
  const entry = originalCreateStructure.call(this, structure, faction, state);
  decorateStructureDecay(entry?.high, structure, "high");
  decorateStructureDecay(entry?.medium, structure, "mid");
  decorateStructureDecay(entry?.low, structure, "low");
  return entry;
};
