import * as THREE from "three";
import { TERRAIN_COLORS, disposeObject, hash2 } from "./shared.js";

export const terrainMethods = {
  buildTerrain(state) {
    disposeObject(this.terrainMesh);
    disposeObject(this.waterMesh);
    disposeObject(this.detailRoot);

    const positions = [], normals = [], colors = [], indices = [];
    const waterMatrices = [];
    const pushQuad = (corners, normal, color) => {
      const base = positions.length / 3;
      for (const corner of corners) {
        positions.push(...corner);
        normals.push(...normal);
        colors.push(color.r, color.g, color.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const stateTile = (x, y) => x >= 0 && y >= 0 && x < state.width && y < state.height
      ? state.tiles[y * state.width + x]
      : null;

    for (const tile of state.tiles) {
      const x = tile.x - state.width / 2;
      const z = tile.y - state.height / 2;
      const height = this.terrainHeight(tile);
      const color = (TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain).clone();
      color.offsetHSL(
        (hash2(tile.x, tile.y, 1) - 0.5) * 0.018,
        0,
        (hash2(tile.x, tile.y, 2) - 0.5) * 0.045,
      );

      if (tile.terrain === "water") {
        const matrix = new THREE.Matrix4();
        matrix.makeRotationX(-Math.PI / 2);
        matrix.setPosition(x + 0.5, height + 0.04, z + 0.5);
        waterMatrices.push(matrix);
        continue;
      }

      pushQuad(
        [[x,height,z],[x+1,height,z],[x+1,height,z+1],[x,height,z+1]],
        [0,1,0],
        color,
      );
      for (const [dx, dy, edge] of [
        [1, 0, "east"], [-1, 0, "west"], [0, 1, "south"], [0, -1, "north"],
      ]) {
        const neighbor = stateTile(tile.x + dx, tile.y + dy);
        const neighborHeight = neighbor ? this.terrainHeight(neighbor) : -0.58;
        if (height <= neighborHeight + 0.02) continue;
        const sideColor = color.clone().multiplyScalar(
          edge === "east" || edge === "west" ? 0.72 : 0.76,
        );
        if (edge === "east") pushQuad(
          [[x+1,neighborHeight,z],[x+1,neighborHeight,z+1],[x+1,height,z+1],[x+1,height,z]],
          [1,0,0], sideColor,
        );
        if (edge === "west") pushQuad(
          [[x,neighborHeight,z+1],[x,neighborHeight,z],[x,height,z],[x,height,z+1]],
          [-1,0,0], sideColor,
        );
        if (edge === "south") pushQuad(
          [[x,neighborHeight,z+1],[x+1,neighborHeight,z+1],[x+1,height,z+1],[x,height,z+1]],
          [0,0,1], sideColor,
        );
        if (edge === "north") pushQuad(
          [[x+1,neighborHeight,z],[x,neighborHeight,z],[x,height,z],[x+1,height,z]],
          [0,0,-1], sideColor,
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
      roughness: 0.97,
      metalness: 0,
      envMapIntensity: 0.38,
    });
    this.terrainMesh = new THREE.Mesh(geometry, material);
    this.terrainMesh.receiveShadow = true;
    this.worldRoot.add(this.terrainMesh);

    const detail = new THREE.Group();

    const underlay = new THREE.Mesh(
      new THREE.BoxGeometry(state.width + 2.4, 0.45, state.height + 2.4),
      new THREE.MeshStandardMaterial({
        color: 0x4f5144,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.2,
      }),
    );
    underlay.position.y = -0.78;
    underlay.receiveShadow = true;
    detail.add(underlay);

    if (waterMatrices.length > 0) {
      const waterMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x397e92,
        roughness: 0.24,
        metalness: 0.04,
        transparent: true,
        opacity: 0.78,
        transmission: 0,
        thickness: 0,
        clearcoat: 0.72,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.92,
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

    const clearingMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b7a5d,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.25,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    for (const structure of state.structures) {
      const tile = stateTile(structure.position.x, structure.position.y);
      if (!tile || tile.terrain === "water") continue;
      const radius = structure.type === "camp" ? 1.2 : 1.42;
      const clearing = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), clearingMaterial);
      clearing.rotation.x = -Math.PI / 2;
      clearing.rotation.z = hash2(structure.position.x, structure.position.y, 301) * Math.PI;
      clearing.scale.set(1, 0.78 + hash2(structure.position.x, structure.position.y, 302) * 0.18, 1);
      clearing.position.copy(this.worldPosition(structure.position, 0.018));
      clearing.receiveShadow = true;
      detail.add(clearing);
    }

    const pathMaterial = new THREE.MeshStandardMaterial({
      color: 0x817054,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.2,
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
        const path = new THREE.Mesh(new THREE.BoxGeometry(length, 0.035, 0.34), pathMaterial);
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
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: 0x63784f,
      roughness: 1,
      metalness: 0,
    });
    const pebbleMaterial = new THREE.MeshStandardMaterial({
      color: 0x77756f,
      roughness: 0.99,
      metalness: 0,
    });
    const grassGeometry = new THREE.ConeGeometry(0.024, 0.13, 4);
    const pebbleGeometry = new THREE.IcosahedronGeometry(0.065, 0);
    const grassThreshold = 0.94 - density * 0.07;
    const pebbleThreshold = 0.92 - density * 0.08;
    const grassTiles = state.tiles.filter((tile) => tile.terrain === "plain"
      && !tile.resource && hash2(tile.x, tile.y, 7) > grassThreshold);
    const pebbleTiles = state.tiles.filter((tile) => tile.terrain === "hill"
      && !tile.resource && hash2(tile.x, tile.y, 8) > pebbleThreshold);

    if (grassTiles.length > 0) {
      const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassTiles.length);
      grassTiles.forEach((tile, index) => {
        const matrix = new THREE.Matrix4();
        matrix.compose(
          this.worldPosition(tile, 0.065).add(new THREE.Vector3(
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
      grass.receiveShadow = true;
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
          this.worldPosition(tile, 0.055).add(new THREE.Vector3(
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
      pebbles.castShadow = true;
      pebbles.receiveShadow = true;
      detail.add(pebbles);
    } else {
      pebbleGeometry.dispose();
      pebbleMaterial.dispose();
    }

    this.detailRoot = detail;
    this.worldRoot.add(detail);

    const extent = Math.max(state.width, state.height) * 0.72;
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
      envMapIntensity: 0.62,
    });
  },
};
