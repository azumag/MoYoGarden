import * as THREE from "three";
import { clamp, disposeObject, hash2, setShadows } from "./shared.js";

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export const resourceMethods = {
  makeLowTree() {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.17, 1.18, 8),
      this.pbrMaterial(0x5b3927, 0.92),
    );
    trunk.position.y = 0.58;
    const lower = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 0.92, 9),
      this.pbrMaterial(0x3f6c43, 0.93),
    );
    lower.position.y = 1.25;
    const upper = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 0.72, 9),
      this.pbrMaterial(0x517b50, 0.91),
    );
    upper.position.y = 1.72;
    group.add(trunk, lower, upper);
    setShadows(group);
    return group;
  },

  makeBush(detail = true) {
    const group = new THREE.Group();
    const material = this.pbrMaterial(0x5e7d43, 0.95);
    const berry = this.pbrMaterial(0xc46b37, 0.8);
    const count = detail ? 4 : 1;
    for (let index = 0; index < count; index += 1) {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(detail ? 0.25 : 0.34, detail ? 1 : 0),
        material,
      );
      const angle = index / Math.max(1, count) * Math.PI * 2;
      mesh.position.set(
        Math.cos(angle) * 0.16,
        0.22 + (index % 2) * 0.07,
        Math.sin(angle) * 0.14,
      );
      group.add(mesh);
    }
    if (detail) {
      for (let index = 0; index < 5; index += 1) {
        const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), berry);
        const angle = index / 5 * Math.PI * 2;
        fruit.position.set(
          Math.cos(angle) * 0.23,
          0.26 + (index % 2) * 0.08,
          Math.sin(angle) * 0.2,
        );
        group.add(fruit);
      }
    }
    setShadows(group);
    return group;
  },

  makeLowRock() {
    const group = new THREE.Group();
    const stone = this.pbrMaterial(0x777b75, 0.96, 0.015);
    for (let index = 0; index < 3; index += 1) {
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), stone);
      mesh.position.set((index - 1) * 0.23, 0.16 + (index % 2) * 0.08, (index % 2) * 0.12);
      mesh.scale.set(1.1, 0.58 + index * 0.09, 0.86);
      group.add(mesh);
    }
    setShadows(group);
    return group;
  },

  resourceVisibilityThreshold(kind) {
    const density = this.quality?.detailDensity ?? 0.75;
    if (kind === "wood") return 0.24 + density * 0.18;
    if (kind === "stone") return 0.2 + density * 0.15;
    return 0.46 + density * 0.18;
  },

  isSettlementClearing(tile, state) {
    const radiusSq = 2.45 * 2.45;
    return state.structures.some((structure) => distanceSq(tile, structure.position) <= radiusSq);
  },

  shouldRenderResource(tile, state) {
    if (this.isSettlementClearing(tile, state)) return false;
    const ratio = clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), 0, 1);
    const threshold = this.resourceVisibilityThreshold(tile.resource.kind)
      + (ratio > 0.88 ? 0.08 : 0);
    return hash2(tile.x, tile.y, 207) < Math.min(0.72, threshold);
  },

  naturalizeModel(root, tile, kind) {
    if (!root) return;
    const hue = (hash2(tile.x, tile.y, 211) - 0.5) * (kind === "wood" ? 0.035 : 0.012);
    const light = (hash2(tile.x, tile.y, 212) - 0.5) * 0.08;
    root.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material.color || material.name?.includes("Faction")) continue;
        material.color.offsetHSL(hue, 0, light);
        material.roughness = clamp(material.roughness ?? 0.8, 0.48, 0.98);
      }
    });
  },

  createResource(tile) {
    let high;
    let medium;
    let low;
    if (tile.resource.kind === "wood") {
      high = this.models.clone("tree", { detail: "high" });
      medium = this.models.clone("tree", { detail: "mid" });
      low = this.makeLowTree();
    } else if (tile.resource.kind === "stone") {
      high = this.models.clone("rock", { detail: "high" });
      medium = this.models.clone("rock", { detail: "mid" });
      low = this.makeLowRock();
    } else {
      high = this.makeBush(true);
      medium = this.makeBush(false);
      low = this.makeBush(false);
      low.scale.setScalar(0.76);
    }
    this.naturalizeModel(high, tile, tile.resource.kind);
    this.naturalizeModel(medium, tile, tile.resource.kind);
    const lod = this.createLod(high, medium, low, [0, 13, 28]);
    lod.rotation.y = hash2(tile.x, tile.y, 99) * Math.PI * 2;
    lod.rotation.z = (hash2(tile.x, tile.y, 213) - 0.5) * 0.045;
    this.resourceRoot.add(lod);
    return { lod, kind: tile.resource.kind };
  },

  syncResources(state) {
    const live = new Set();
    for (const tile of state.tiles) {
      if (!tile.resource || tile.resource.amount <= 0 || tile.terrain === "water") continue;
      if (!this.shouldRenderResource(tile, state)) continue;
      const key = `${tile.x}:${tile.y}`;
      live.add(key);
      let entry = this.resourceObjects.get(key);
      if (!entry || entry.kind !== tile.resource.kind) {
        if (entry) disposeObject(entry.lod);
        entry = this.createResource(tile);
        this.resourceObjects.set(key, entry);
      }
      const density = clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), 0.22, 1);
      const jitterX = (hash2(tile.x, tile.y, 214) - 0.5) * 0.34;
      const jitterZ = (hash2(tile.x, tile.y, 215) - 0.5) * 0.34;
      entry.lod.position.copy(this.worldPosition(tile, 0));
      entry.lod.position.x += jitterX;
      entry.lod.position.z += jitterZ;
      const variation = 0.88 + hash2(tile.x, tile.y, 216) * 0.24;
      const baseScale = tile.resource.kind === "wood"
        ? 0.5
        : tile.resource.kind === "stone" ? 0.58 : 0.72;
      entry.lod.scale.setScalar(baseScale * variation * (0.78 + density * 0.24));
    }
    for (const [key, entry] of this.resourceObjects) {
      if (live.has(key)) continue;
      disposeObject(entry.lod);
      this.resourceObjects.delete(key);
    }
  },
};
