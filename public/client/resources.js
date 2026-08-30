import * as THREE from "three";
import { clamp, disposeObject, hash2, setShadows } from "./shared.js";

export const resourceMethods = {
  makeLowTree() {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, 1.05, 6),
      this.pbrMaterial(0x4b2811, 0.95),
    );
    trunk.position.y = 0.52;
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(0.65, 1.35, 7),
      this.pbrMaterial(0x245d2b, 0.92),
    );
    crown.position.y = 1.45;
    group.add(trunk, crown);
    setShadows(group);
    return group;
  },

  makeBush(detail = true) {
    const group = new THREE.Group();
    const material = this.pbrMaterial(0x4f7e2f, 0.94);
    const berry = this.pbrMaterial(0xe66a24, 0.72);
    const count = detail ? 4 : 1;
    for (let index = 0; index < count; index += 1) {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(detail ? 0.28 : 0.38, detail ? 1 : 0),
        material,
      );
      const angle = index / Math.max(1, count) * Math.PI * 2;
      mesh.position.set(
        Math.cos(angle) * 0.18,
        0.25 + (index % 2) * 0.08,
        Math.sin(angle) * 0.16,
      );
      group.add(mesh);
    }
    if (detail) {
      for (let index = 0; index < 7; index += 1) {
        const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), berry);
        const angle = index / 7 * Math.PI * 2;
        fruit.position.set(
          Math.cos(angle) * 0.28,
          0.28 + (index % 3) * 0.09,
          Math.sin(angle) * 0.24,
        );
        group.add(fruit);
      }
    }
    setShadows(group);
    return group;
  },

  makeLowRock() {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45, 0),
      this.pbrMaterial(0x6f716b, 0.98, 0.02),
    );
    mesh.scale.set(1.2, 0.65, 0.9);
    setShadows(mesh);
    return mesh;
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
      low.scale.setScalar(0.75);
    }
    const lod = this.createLod(high, medium, low, [0, 13, 28]);
    lod.rotation.y = hash2(tile.x, tile.y, 99) * Math.PI * 2;
    this.resourceRoot.add(lod);
    return { lod, kind: tile.resource.kind };
  },

  syncResources(state) {
    const live = new Set();
    for (const tile of state.tiles) {
      if (!tile.resource || tile.resource.amount <= 0 || tile.terrain === "water") continue;
      const key = `${tile.x}:${tile.y}`;
      live.add(key);
      let entry = this.resourceObjects.get(key);
      if (!entry || entry.kind !== tile.resource.kind) {
        if (entry) disposeObject(entry.lod);
        entry = this.createResource(tile);
        this.resourceObjects.set(key, entry);
      }
      const density = clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), 0.22, 1);
      entry.lod.position.copy(this.worldPosition(tile, 0));
      const baseScale = tile.resource.kind === "wood"
        ? 0.62
        : tile.resource.kind === "stone" ? 0.75 : 0.85;
      entry.lod.scale.setScalar(baseScale * (0.72 + density * 0.36));
    }
    for (const [key, entry] of this.resourceObjects) {
      if (live.has(key)) continue;
      disposeObject(entry.lod);
      this.resourceObjects.delete(key);
    }
  },
};
