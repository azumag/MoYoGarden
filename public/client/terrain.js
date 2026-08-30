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
        (hash2(tile.x, tile.y, 1) - 0.5) * 0.025,
        0,
        (hash2(tile.x, tile.y, 2) - 0.5) * 0.07,
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
      const sides = [
        [1, 0, "east"], [-1, 0, "west"], [0, 1, "south"], [0, -1, "north"],
      ];
      for (const [dx, dy, edge] of sides) {
        const neighbor = stateTile(tile.x + dx, tile.y + dy);
        const neighborHeight = neighbor ? this.terrainHeight(neighbor) : -0.6;
        if (height <= neighborHeight + 0.02) continue;
        const sideColor = color.clone().multiplyScalar(
          edge === "east" || edge === "west" ? 0.67 : 0.73,
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
      roughness: 0.94,
      metalness: 0.01,
      envMapIntensity: 0.48,
    });
    this.terrainMesh = new THREE.Mesh(geometry, material);
    this.terrainMesh.receiveShadow = true;
    this.worldRoot.add(this.terrainMesh);

    if (waterMatrices.length > 0) {
      const waterMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x246a82,
        roughness: 0.18,
        metalness: 0.08,
        transparent: true,
        opacity: 0.72,
        transmission: 0.12,
        thickness: 0.3,
        clearcoat: 0.9,
        clearcoatRoughness: 0.18,
        envMapIntensity: 1.15,
      });
      this.waterMesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        waterMaterial,
        waterMatrices.length,
      );
      waterMatrices.forEach((matrix, index) => this.waterMesh.setMatrixAt(index, matrix));
      this.waterMesh.instanceMatrix.needsUpdate = true;
      this.waterMesh.receiveShadow = true;
      this.worldRoot.add(this.waterMesh);
    }

    const detail = new THREE.Group();
    const grassMaterial = new THREE.MeshStandardMaterial({ color: 0x6e8f49, roughness: 1, metalness: 0 });
    const pebbleMaterial = new THREE.MeshStandardMaterial({ color: 0x777268, roughness: 0.98, metalness: 0.01 });
    const grassGeometry = new THREE.ConeGeometry(0.035, 0.22, 4);
    const pebbleGeometry = new THREE.IcosahedronGeometry(0.08, 0);
    const grassTiles = state.tiles.filter((tile) => tile.terrain === "plain"
      && !tile.resource && hash2(tile.x, tile.y, 7) > 0.52);
    const pebbleTiles = state.tiles.filter((tile) => tile.terrain === "hill"
      && !tile.resource && hash2(tile.x, tile.y, 8) > 0.58);

    if (grassTiles.length > 0) {
      const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassTiles.length * 2);
      let instance = 0;
      for (const tile of grassTiles) {
        for (let index = 0; index < 2; index += 1) {
          const matrix = new THREE.Matrix4();
          matrix.compose(
            this.worldPosition(tile, 0.11).add(new THREE.Vector3(
              (hash2(tile.x,tile.y,20+index)-0.5)*0.62,
              0,
              (hash2(tile.x,tile.y,30+index)-0.5)*0.62,
            )),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(
              0,
              hash2(tile.x,tile.y,40+index)*Math.PI,
              0,
            )),
            new THREE.Vector3(
              0.8 + hash2(tile.x,tile.y,50+index)*0.7,
              0.8 + hash2(tile.x,tile.y,60+index)*0.7,
              0.8,
            ),
          );
          grass.setMatrixAt(instance, matrix);
          instance += 1;
        }
      }
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
          this.worldPosition(tile, 0.07).add(new THREE.Vector3(
            (hash2(tile.x,tile.y,72)-0.5)*0.55,
            0,
            (hash2(tile.x,tile.y,73)-0.5)*0.55,
          )),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            hash2(tile.x,tile.y,74),
            hash2(tile.x,tile.y,75)*Math.PI,
            0,
          )),
          new THREE.Vector3(
            0.8+hash2(tile.x,tile.y,76),
            0.45+hash2(tile.x,tile.y,77)*0.5,
            0.8,
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
  },

  pbrMaterial(color, roughness = 0.8, metalness = 0) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      envMapIntensity: 0.75,
    });
  },
};
