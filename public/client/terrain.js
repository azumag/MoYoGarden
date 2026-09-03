import * as THREE from "three";
import { TERRAIN_COLORS, disposeObject, hash2 } from "./shared.js";

const WATER_MOISTURE_RADIUS = 4;
const DRY_GROUND = new THREE.Color(0xa18c68);
const MOIST_GROUND = new THREE.Color(0x617b58);
const UPLAND_GROUND = new THREE.Color(0x8d8b78);

function quadNormal(corners) {
  const a = new THREE.Vector3(
    corners[3][0] - corners[0][0],
    corners[3][1] - corners[0][1],
    corners[3][2] - corners[0][2],
  );
  const b = new THREE.Vector3(
    corners[1][0] - corners[0][0],
    corners[1][1] - corners[0][1],
    corners[1][2] - corners[0][2],
  );
  return a.cross(b).normalize().toArray();
}

function environmentalMoisture(stateTile, tile) {
  if (!tile) return 0;
  if (tile.terrain === "water") return 1;

  let waterInfluence = 0;
  for (let dy = -WATER_MOISTURE_RADIUS; dy <= WATER_MOISTURE_RADIUS; dy += 1) {
    for (let dx = -WATER_MOISTURE_RADIUS; dx <= WATER_MOISTURE_RADIUS; dx += 1) {
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance === 0 || distance > WATER_MOISTURE_RADIUS) continue;
      if (stateTile(tile.x + dx, tile.y + dy)?.terrain !== "water") continue;
      waterInfluence = Math.max(
        waterInfluence,
        (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
      );
    }
  }

  const vegetationCover = tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
    ? tile.resource.amount / tile.resource.maxAmount
    : 0;
  const elevation = Number.isFinite(tile.elevation) ? tile.elevation : 0.5;
  const lowlandRetention = (1 - elevation) * 0.12;
  return Math.min(1, 0.05 + lowlandRetention + waterInfluence * 0.7 + vegetationCover * 0.16);
}

function environmentalTerrainColor(stateTile, tile) {
  const color = (TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain).clone();
  const moisture = environmentalMoisture(stateTile, tile);
  const elevation = Number.isFinite(tile.elevation) ? tile.elevation : 0.5;
  const environment = DRY_GROUND.clone().lerp(MOIST_GROUND, moisture);
  environment.lerp(UPLAND_GROUND, Math.max(0, elevation - 0.52) * 0.5);
  return color.lerp(environment, 0.34);
}

export const terrainMethods = {
  buildTerrain(state) {
    disposeObject(this.terrainMesh);
    disposeObject(this.waterMesh);
    disposeObject(this.detailRoot);

    const positions = [], normals = [], colors = [], indices = [];
    const waterMatrices = [];
    const surfaceHeights = new Map();
    const pushQuad = (corners, normal, color) => {
      const base = positions.length / 3;
      const resolvedNormal = normal || quadNormal(corners);
      for (const corner of corners) {
        positions.push(...corner);
        normals.push(...resolvedNormal);
        colors.push(color.r, color.g, color.b);
      }
      // The corner order is convenient for edge construction but winds downward.
      // Reverse the triangle winding so terrain and cliff fronts face the camera/outside.
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const stateTile = (x, y) => x >= 0 && y >= 0 && x < state.width && y < state.height
      ? state.tiles[y * state.width + x]
      : null;
    const tileHeight = (tile) => {
      if (!tile || tile.terrain === "water") return this.terrainHeight(tile);
      if (Number.isFinite(tile.elevation)) return 0.015 + tile.elevation * 0.62;
      return this.terrainHeight(tile);
    };

    const cornerHeight = (vertexX, vertexY, fallbackTile) => {
      const samples = [];
      for (const dx of [-1, 0]) {
        for (const dy of [-1, 0]) {
          const tile = stateTile(vertexX + dx, vertexY + dy);
          if (tile && tile.terrain !== "water") samples.push(tileHeight(tile));
        }
      }
      const base = samples.length > 0
        ? samples.reduce((sum, value) => sum + value, 0) / samples.length
        : tileHeight(fallbackTile);
      const noise = (hash2(vertexX, vertexY, 501) - 0.5) * 0.055;
      return base + noise;
    };

    const topCorners = new Map();
    for (const tile of state.tiles) {
      if (tile.terrain === "water") continue;
      const x = tile.x - state.width / 2;
      const z = tile.y - state.height / 2;
      const h00 = cornerHeight(tile.x, tile.y, tile);
      const h10 = cornerHeight(tile.x + 1, tile.y, tile);
      const h11 = cornerHeight(tile.x + 1, tile.y + 1, tile);
      const h01 = cornerHeight(tile.x, tile.y + 1, tile);
      topCorners.set(`${tile.x}:${tile.y}`, { h00, h10, h11, h01 });

      const color = environmentalTerrainColor(stateTile, tile);
      const averageHeight = (h00 + h10 + h11 + h01) * 0.25;
      surfaceHeights.set(`${tile.x}:${tile.y}`, averageHeight);
      const elevation = Number.isFinite(tile.elevation) ? tile.elevation : 0.5;
      color.offsetHSL(
        (hash2(tile.x, tile.y, 1) - 0.5) * 0.018,
        tile.terrain === "forest" ? 0.018 : 0,
        (hash2(tile.x, tile.y, 2) - 0.5) * 0.035 + (elevation - 0.5) * 0.026,
      );
      const corners = [
        [x, h00, z],
        [x + 1, h10, z],
        [x + 1, h11, z + 1],
        [x, h01, z + 1],
      ];
      pushQuad(corners, null, color);
    }
    this.surfaceHeightMap = surfaceHeights;

    for (const tile of state.tiles) {
      const x = tile.x - state.width / 2;
      const z = tile.y - state.height / 2;
      if (tile.terrain === "water") {
        const matrix = new THREE.Matrix4();
        matrix.makeRotationX(-Math.PI / 2);
        matrix.setPosition(x + 0.5, this.terrainHeight(tile) + 0.035, z + 0.5);
        waterMatrices.push(matrix);
        continue;
      }
      const heights = topCorners.get(`${tile.x}:${tile.y}`);
      if (!heights) continue;
      const color = environmentalTerrainColor(stateTile, tile).multiplyScalar(0.72);
      for (const [dx, dy, edge] of [
        [1, 0, "east"], [-1, 0, "west"], [0, 1, "south"], [0, -1, "north"],
      ]) {
        const neighbor = stateTile(tile.x + dx, tile.y + dy);
        if (neighbor && neighbor.terrain !== "water") continue;
        const bottom = neighbor?.terrain === "water" ? this.terrainHeight(neighbor) + 0.02 : -0.62;
        if (edge === "east") pushQuad(
          [[x+1,bottom,z],[x+1,bottom,z+1],[x+1,heights.h11,z+1],[x+1,heights.h10,z]],
          [1,0,0], color,
        );
        if (edge === "west") pushQuad(
          [[x,bottom,z+1],[x,bottom,z],[x,heights.h00,z],[x,heights.h01,z+1]],
          [-1,0,0], color,
        );
        if (edge === "south") pushQuad(
          [[x,bottom,z+1],[x+1,bottom,z+1],[x+1,heights.h11,z+1],[x,heights.h01,z+1]],
          [0,0,1], color,
        );
        if (edge === "north") pushQuad(
          [[x+1,bottom,z],[x,bottom,z],[x,heights.h00,z],[x+1,heights.h10,z]],
          [0,0,-1], color,
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.985,
      metalness: 0,
      envMapIntensity: 0.3,
    });
    this.terrainMesh = new THREE.Mesh(geometry, material);
    this.terrainMesh.receiveShadow = true;
    this.worldRoot.add(this.terrainMesh);

    const detail = new THREE.Group();

    const underlay = new THREE.Mesh(
      new THREE.BoxGeometry(state.width + 2.6, 0.5, state.height + 2.6),
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

    if (waterMatrices.length > 0) {
      const waterMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x4a91a3,
        roughness: 0.2,
        metalness: 0.03,
        transparent: true,
        opacity: 0.75,
        transmission: 0,
        thickness: 0,
        clearcoat: 0.82,
        clearcoatRoughness: 0.24,
        envMapIntensity: 1.02,
        depthWrite: false,
      });
      this.waterMesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        waterMaterial,
        waterMatrices.length,
      );
      waterMatrices.forEach((matrix, index) => this.waterMesh.setMatrixAt(index, matrix));
      this.waterMesh.instanceMatrix.needsUpdate = true;
      this.waterMesh.receiveShadow = false;
      this.waterMesh.renderOrder = 2;
      this.worldRoot.add(this.waterMesh);
    }

    const shorelineMaterial = new THREE.MeshStandardMaterial({
      color: 0x9c9474,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.14,
    });
    for (const tile of state.tiles) {
      if (tile.terrain === "water") continue;
      const center = this.worldPosition(tile, 0.012);
      for (const [dx, dy, edge] of [
        [1,0,"east"],[-1,0,"west"],[0,1,"south"],[0,-1,"north"],
      ]) {
        const neighbor = stateTile(tile.x + dx, tile.y + dy);
        if (!neighbor || neighbor.terrain !== "water") continue;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(
          edge === "east" || edge === "west" ? 0.09 : 0.94,
          0.025,
          edge === "east" || edge === "west" ? 0.94 : 0.09,
        ), shorelineMaterial);
        strip.position.copy(center);
        strip.position.y = (surfaceHeights.get(`${tile.x}:${tile.y}`) ?? this.terrainHeight(tile)) + 0.028;
        if (edge === "east") strip.position.x += 0.455;
        if (edge === "west") strip.position.x -= 0.455;
        if (edge === "south") strip.position.z += 0.455;
        if (edge === "north") strip.position.z -= 0.455;
        strip.receiveShadow = true;
        detail.add(strip);
      }
    }

    const clearingMaterial = new THREE.MeshStandardMaterial({
      color: 0x958369,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.18,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    for (const structure of state.structures) {
      const tile = stateTile(structure.position.x, structure.position.y);
      if (!tile || tile.terrain === "water") continue;
      const radius = structure.type === "camp" ? 1.26 : 1.5;
      const clearing = new THREE.Mesh(new THREE.CircleGeometry(radius, 36), clearingMaterial);
      clearing.rotation.x = -Math.PI / 2;
      clearing.rotation.z = hash2(structure.position.x, structure.position.y, 301) * Math.PI;
      clearing.scale.set(1, 0.8 + hash2(structure.position.x, structure.position.y, 302) * 0.15, 1);
      clearing.position.copy(this.worldPosition(structure.position, 0.02));
      clearing.receiveShadow = true;
      detail.add(clearing);
    }

    const pathMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b7659,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.14,
    });
    for (const faction of state.factions) {
      const structures = state.structures
        .filter((structure) => structure.factionId === faction.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (let index = 1; index < structures.length; index += 1) {
        const a = structures[index - 1].position;
        const b = structures[index].position;
        const start = this.worldPosition(a, 0.025);
        const end = this.worldPosition(b, 0.025);
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.2) continue;
        const path = new THREE.Mesh(new THREE.BoxGeometry(length, 0.03, 0.3), pathMaterial);
        path.position.set(
          (start.x + end.x) * 0.5,
          Math.max(start.y, end.y) + 0.012,
          (start.z + end.z) * 0.5,
        );
        path.rotation.y = -Math.atan2(dz, dx);
        path.receiveShadow = true;
        detail.add(path);
      }
    }

    const density = this.quality.detailDensity;
    const microDetailShadows = this.quality.id !== "balanced";
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: 0x70815d,
      roughness: 1,
      metalness: 0,
    });
    const pebbleMaterial = new THREE.MeshStandardMaterial({
      color: 0x817d75,
      roughness: 0.99,
      metalness: 0,
    });
    const grassGeometry = new THREE.ConeGeometry(0.022, 0.12, 4);
    const pebbleGeometry = new THREE.IcosahedronGeometry(0.06, 0);
    const grassThreshold = 0.955 - density * 0.055;
    const pebbleThreshold = 0.94 - density * 0.065;
    const grassTiles = state.tiles.filter((tile) => tile.terrain === "plain"
      && !tile.resource && hash2(tile.x, tile.y, 7) > grassThreshold);
    const pebbleTiles = state.tiles.filter((tile) => tile.terrain === "hill"
      && !tile.resource && hash2(tile.x, tile.y, 8) > pebbleThreshold);

    if (grassTiles.length > 0) {
      const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassTiles.length);
      grassTiles.forEach((tile, index) => {
        const matrix = new THREE.Matrix4();
        matrix.compose(
          this.worldPosition(tile, 0.06).add(new THREE.Vector3(
            (hash2(tile.x,tile.y,20)-0.5)*0.58,
            0,
            (hash2(tile.x,tile.y,30)-0.5)*0.58,
          )),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            0,
            hash2(tile.x,tile.y,40)*Math.PI,
            0,
          )),
          new THREE.Vector3(0.8, 0.8 + hash2(tile.x,tile.y,50)*0.5, 0.8),
        );
        grass.setMatrixAt(index, matrix);
      });
      grass.instanceMatrix.needsUpdate = true;
      grass.receiveShadow = microDetailShadows;
      detail.add(grass);
    } else {
      grassGeometry.dispose();
      grassMaterial.dispose();
    }

    if (pebbleTiles.length > 0) {
      const pebbles = new THREE.InstancedMesh(pebbleGeometry, pebbleMaterial, pebbleTiles.length);
      pebbleTiles.forEach((tile, index) => {
        const matrix = new THREE.Matrix4();
        matrix.compose(
          this.worldPosition(tile, 0.05).add(new THREE.Vector3(
            (hash2(tile.x,tile.y,72)-0.5)*0.5,
            0,
            (hash2(tile.x,tile.y,73)-0.5)*0.5,
          )),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            hash2(tile.x,tile.y,74) * 0.5,
            hash2(tile.x,tile.y,75)*Math.PI,
            0,
          )),
          new THREE.Vector3(
            0.75+hash2(tile.x,tile.y,76)*0.65,
            0.42+hash2(tile.x,tile.y,77)*0.4,
            0.75,
          ),
        );
        pebbles.setMatrixAt(index, matrix);
      });
      pebbles.instanceMatrix.needsUpdate = true;
      pebbles.castShadow = microDetailShadows;
      pebbles.receiveShadow = microDetailShadows;
      detail.add(pebbles);
    } else {
      pebbleGeometry.dispose();
      pebbleMaterial.dispose();
    }

    this.detailRoot = detail;
    this.worldRoot.add(detail);

    const extent = Math.max(state.width, state.height) * 0.7;
    Object.assign(this.sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      near: 1,
      far: 75,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.markShadowsDirty();
  },

  pbrMaterial(color, roughness = 0.8, metalness = 0) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      envMapIntensity: 0.58,
    });
  },
};