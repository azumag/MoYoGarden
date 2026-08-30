import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export class ModelLibrary {
  constructor() {
    this.loader = new GLTFLoader();
    this.templates = new Map();
  }

  async load() {
    const manifest = {
      settler: "/models/settler.glb",
      tree: "/models/tree.glb",
      rock: "/models/rock.glb",
      buildings: "/models/buildings.glb",
    };
    const entries = await Promise.all(Object.entries(manifest).map(async ([key, url]) => {
      const gltf = await this.loader.loadAsync(url);
      return [key, gltf.scene];
    }));
    for (const [key, scene] of entries) this.templates.set(key, scene);
  }

  source(name, childName) {
    const root = this.templates.get(name);
    if (!root) return null;
    return childName ? root.getObjectByName(childName) : root;
  }

  clone(name, { childName, factionColor, role, detail = "high" } = {}) {
    const source = this.source(name, childName);
    if (!source) return null;
    const clone = source.clone(true);
    const faction = new THREE.Color(factionColor || 0xffffff);

    clone.traverse((object) => {
      if ((object.userData.moyoDetail || object.name.startsWith("detail_")) && detail !== "high") {
        object.visible = false;
      }
      if (object.name.startsWith("Role_")) {
        object.visible = detail === "high" && object.name.startsWith(`Role_${role}_`);
      }
      if (!object.isMesh) return;

      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const materials = sourceMaterials.map((material) => {
        const copy = material.clone();
        if (copy.name.includes("Faction")) {
          const baseColor = copy.color.clone();
          copy.color.copy(faction).lerp(baseColor, 0.18);
          copy.roughness = Math.max(0.56, copy.roughness ?? 0.8);
        }
        copy.envMapIntensity = detail === "high" ? 0.9 : 0.65;
        return copy;
      });
      object.geometry = object.geometry.clone();
      object.material = Array.isArray(object.material) ? materials : materials[0];
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return clone;
  }
}
