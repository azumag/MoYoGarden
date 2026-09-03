import * as THREE from "three";
import { clamp, disposeObject, hash2, setShadows } from "./shared.js";

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function fitAuthoredModel(root, targetHeight) {
  if (!root) return null;
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!Number.isFinite(size.y) || size.y <= 0.0001) return root;
  const scale = targetHeight / size.y;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  return root;
}

function authoredTreeKey(tile) {
  return hash2(tile.x, tile.y, 801) < 0.54 ? "authored:tree-oak" : "authored:tree-pine";
}

function authoredRockKey(tile) {
  const value = hash2(tile.x, tile.y, 802);
  if (value < 0.34) return "authored:rock-small";
  if (value < 0.72) return "authored:rock-medium";
  return "authored:rock-large";
}

function resourceAbundance(tile) {
  return clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), 0, 1);
}

export const resourceMethods = {
  makeLowTree(tile = { x: 0, y: 0 }) {
    const group = new THREE.Group();
    const style = Math.floor(hash2(tile.x, tile.y, 601) * 3);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.095, 0.17, 1.18, 8),
      this.pbrMaterial(0x5b3927, 0.92),
    );
    trunk.position.y = 0.59;
    const lower = new THREE.Mesh(
      style === 1
        ? new THREE.SphereGeometry(0.48, 9, 7)
        : new THREE.ConeGeometry(style === 2 ? 0.47 : 0.55, style === 2 ? 1.05 : 0.92, 9),
      this.pbrMaterial(style === 2 ? 0x375f3e : 0x436f47, 0.93),
    );
    lower.position.y = style === 2 ? 1.38 : 1.27;
    const upper = new THREE.Mesh(
      style === 1
        ? new THREE.SphereGeometry(0.36, 9, 7)
        : new THREE.ConeGeometry(style === 2 ? 0.31 : 0.4, style === 2 ? 0.82 : 0.72, 9),
      this.pbrMaterial(0x557f55, 0.91),
    );
    upper.position.set(style === 1 ? 0.11 : -0.04, style === 2 ? 1.94 : 1.72, 0.02);
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

  makeLowRock(tile = { x: 0, y: 0 }) {
    const group = new THREE.Group();
    const stone = this.pbrMaterial(0x777b75, 0.96, 0.015);
    const count = hash2(tile.x, tile.y, 602) > 0.55 ? 3 : 2;
    for (let index = 0; index < count; index += 1) {
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), stone);
      const scatter = 0.18 + hash2(tile.x, tile.y, 610 + index) * 0.12;
      mesh.position.set((index - (count - 1) / 2) * scatter, 0.13 + (index % 2) * 0.07, (index % 2) * 0.1);
      mesh.scale.set(
        0.85 + hash2(tile.x, tile.y, 620 + index) * 0.45,
        0.42 + hash2(tile.x, tile.y, 630 + index) * 0.34,
        0.72 + hash2(tile.x, tile.y, 640 + index) * 0.34,
      );
      mesh.rotation.set(
        (hash2(tile.x, tile.y, 650 + index) - 0.5) * 0.25,
        hash2(tile.x, tile.y, 660 + index) * Math.PI,
        (hash2(tile.x, tile.y, 670 + index) - 0.5) * 0.22,
      );
      group.add(mesh);
    }
    setShadows(group);
    return group;
  },

  resourceVisibilityThreshold(kind) {
    const density = this.quality?.detailDensity ?? 0.75;
    if (kind === "wood") return 0.21 + density * 0.14;
    if (kind === "stone") return 0.18 + density * 0.12;
    return 0.42 + density * 0.16;
  },

  isSettlementClearing(tile, state) {
    const radiusSq = 2.65 * 2.65;
    return state.structures.some((structure) => distanceSq(tile, structure.position) <= radiusSq);
  },

  shouldRenderResource(tile, state) {
    if (this.isSettlementClearing(tile, state)) return false;
    const ratio = resourceAbundance(tile);
    const abundanceVisibility = 0.3 + Math.sqrt(ratio) * 0.7;
    const richBonus = ratio > 0.88 ? 0.055 : 0;
    const threshold = this.resourceVisibilityThreshold(tile.resource.kind) * abundanceVisibility + richBonus;
    return hash2(tile.x, tile.y, 207) < Math.min(0.62, threshold);
  },

  naturalizeModel(root, tile, kind) {
    if (!root) return;
    const hue = (hash2(tile.x, tile.y, 211) - 0.5) * (kind === "wood" ? 0.045 : 0.014);
    const light = (hash2(tile.x, tile.y, 212) - 0.5) * 0.1;
    const style = Math.floor(hash2(tile.x, tile.y, 603) * 3);
    root.traverse((object) => {
      if (object.isMesh && object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material.color || material.name?.includes("Faction")) continue;
          material.color.offsetHSL(hue, 0, light);
          material.roughness = clamp(material.roughness ?? 0.8, 0.48, 0.98);
        }
      }
      if (kind === "wood" && object.name.startsWith("Foliage")) {
        const index = Number(object.name.replace("Foliage", "")) || 0;
        const radial = 0.86 + hash2(tile.x, tile.y, 680 + index) * 0.3;
        const vertical = style === 2 ? 1.08 + index * 0.018 : style === 1 ? 0.82 : 0.94;
        object.scale.x *= radial * (style === 1 ? 1.16 : 1);
        object.scale.z *= radial * (style === 1 ? 1.08 : 1);
        object.scale.y *= vertical;
        object.position.x += (hash2(tile.x, tile.y, 690 + index) - 0.5) * 0.16;
        object.position.z += (hash2(tile.x, tile.y, 700 + index) - 0.5) * 0.14;
        if (style === 2 && index === 4 && hash2(tile.x, tile.y, 711) > 0.42) object.visible = false;
      }
      if (kind === "wood" && object.name === "Trunk") {
        object.scale.y *= style === 2 ? 1.16 : style === 1 ? 0.88 : 1;
        object.scale.x *= style === 1 ? 1.12 : 0.96;
        object.scale.z *= style === 1 ? 1.08 : 0.96;
      }
      if (kind === "stone" && object.name.startsWith("Rock")) {
        const index = Number(object.name.replace("Rock", "")) || 0;
        object.scale.x *= 0.8 + hash2(tile.x, tile.y, 720 + index) * 0.52;
        object.scale.y *= 0.72 + hash2(tile.x, tile.y, 730 + index) * 0.42;
        object.scale.z *= 0.78 + hash2(tile.x, tile.y, 740 + index) * 0.48;
        object.rotation.y += hash2(tile.x, tile.y, 750 + index) * Math.PI;
        if (index === 3 && hash2(tile.x, tile.y, 760) > 0.58) object.visible = false;
      }
    });
  },

  createResource(tile) {
    let high;
    let medium;
    let low;
    let authored = false;
    if (tile.resource.kind === "wood") {
      const key = authoredTreeKey(tile);
      high = fitAuthoredModel(this.models.clone(key, { detail: "high" }), key.endsWith("pine") ? 4.25 : 3.55);
      medium = fitAuthoredModel(this.models.clone(key, { detail: "mid" }), key.endsWith("pine") ? 4.25 : 3.55);
      authored = Boolean(high && medium);
      if (!authored) {
        high = this.models.clone("tree", { detail: "high" });
        medium = this.models.clone("tree", { detail: "mid" });
      }
      low = this.makeLowTree(tile);
    } else if (tile.resource.kind === "stone") {
      const key = authoredRockKey(tile);
      const targetHeight = key.endsWith("small") ? 0.7 : key.endsWith("medium") ? 1.0 : 1.3;
      high = fitAuthoredModel(this.models.clone(key, { detail: "high" }), targetHeight);
      medium = fitAuthoredModel(this.models.clone(key, { detail: "mid" }), targetHeight);
      authored = Boolean(high && medium);
      if (!authored) {
        high = this.models.clone("rock", { detail: "high" });
        medium = this.models.clone("rock", { detail: "mid" });
      }
      low = this.makeLowRock(tile);
    } else {
      high = this.makeBush(true);
      medium = this.makeBush(false);
      low = this.makeBush(false);
      low.scale.setScalar(0.76);
    }
    this.naturalizeModel(high, tile, tile.resource.kind);
    this.naturalizeModel(medium, tile, tile.resource.kind);
    if (this.quality.id === "balanced") setShadows(low, false, true);
    const lod = this.createLod(high, medium, low, authored ? [0, 16, 32] : [0, 13, 28]);
    lod.rotation.y = hash2(tile.x, tile.y, 99) * Math.PI * 2;
    lod.rotation.z = (hash2(tile.x, tile.y, 213) - 0.5) * 0.052;
    lod.userData.authoredNature = authored;
    this.resourceRoot.add(lod);
    return { lod, kind: tile.resource.kind, authored };
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
      const abundance = resourceAbundance(tile);
      const density = clamp(abundance, 0.05, 1);
      const jitterX = (hash2(tile.x, tile.y, 214) - 0.5) * 0.48;
      const jitterZ = (hash2(tile.x, tile.y, 215) - 0.5) * 0.48;
      entry.lod.position.copy(this.worldPosition(tile, 0));
      entry.lod.position.x += jitterX;
      entry.lod.position.z += jitterZ;

      const variation = 0.86 + hash2(tile.x, tile.y, 216) * 0.25;
      const densityScale = 0.5 + Math.sqrt(density) * 0.5;
      const authoredScale = entry.authored ? 0.94 : 1;
      if (tile.resource.kind === "wood") {
        const style = Math.floor(hash2(tile.x, tile.y, 603) * 3);
        const base = 0.46 * variation * densityScale * authoredScale;
        const width = style === 1 ? 1.16 : style === 2 ? 0.78 : 0.96;
        const height = style === 1 ? 0.84 : style === 2 ? 1.24 : 1;
        entry.lod.scale.set(base * width, base * height, base * (0.92 + hash2(tile.x, tile.y, 770) * 0.16));
      } else if (tile.resource.kind === "stone") {
        const base = 0.54 * variation * densityScale * authoredScale;
        entry.lod.scale.set(
          base * (0.88 + hash2(tile.x, tile.y, 771) * 0.34),
          base * (0.72 + hash2(tile.x, tile.y, 772) * 0.34),
          base * (0.84 + hash2(tile.x, tile.y, 773) * 0.34),
        );
      } else {
        const base = 0.66 * variation * densityScale;
        entry.lod.scale.set(
          base * (0.9 + hash2(tile.x, tile.y, 774) * 0.2),
          base * (0.82 + hash2(tile.x, tile.y, 775) * 0.24),
          base * (0.9 + hash2(tile.x, tile.y, 776) * 0.2),
        );
      }
    }
    for (const [key, entry] of this.resourceObjects) {
      if (live.has(key)) continue;
      disposeObject(entry.lod);
      this.resourceObjects.delete(key);
    }
  },
};
