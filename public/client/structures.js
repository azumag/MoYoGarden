import * as THREE from "three";
import { STRUCTURE_NAMES, clamp, disposeObject, hash2, setShadows } from "./shared.js";

export const structureMethods = {
  makeLowBuilding(type, factionColor) {
    const group = new THREE.Group();
    const wallColor = type === "workshop"
      ? 0x77756d
      : type === "market" ? 0x96643a : type === "camp" ? 0x8a7251 : 0x76502a;
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.14, 1.1),
      this.pbrMaterial(0x685f52, 0.97),
    );
    foundation.position.y = 0.07;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.18, 0.82, 0.92),
      this.pbrMaterial(wallColor, 0.86),
    );
    body.position.y = 0.52;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.92, 0.5, 4),
      this.pbrMaterial(factionColor, 0.74),
    );
    roof.position.y = 1.14;
    roof.rotation.y = Math.PI / 4;
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.46, 0.035),
      this.pbrMaterial(0x4e3222, 0.9),
    );
    door.position.set(0, 0.35, 0.48);
    group.add(foundation, body, roof, door);
    setShadows(group);
    return group;
  },

  createStructure(structure, faction) {
    const childName = STRUCTURE_NAMES[structure.type] || "Storehouse";
    const high = this.models.clone("buildings", {
      childName,
      factionColor: faction.color,
      detail: "high",
    });
    const medium = this.models.clone("buildings", {
      childName,
      factionColor: faction.color,
      detail: "mid",
    });
    const low = this.makeLowBuilding(structure.type, faction.color);
    const lod = this.createLod(high, medium, low, [0, 20, 42]);
    lod.userData.structureId = structure.id;
    lod.rotation.y = hash2(structure.position.x, structure.position.y, 120) > 0.5
      ? 0
      : Math.PI / 2;
    this.structureRoot.add(lod);
    return {
      lod,
      high,
      medium,
      low,
      type: structure.type,
      factionId: structure.factionId,
    };
  },

  syncStructures(state) {
    const live = new Set();
    for (const structure of state.structures) {
      live.add(structure.id);
      const faction = state.factions.find((value) => value.id === structure.factionId)
        || { color: "#999999" };
      let entry = this.structureObjects.get(structure.id);
      if (!entry || entry.type !== structure.type || entry.factionId !== structure.factionId) {
        if (entry) disposeObject(entry.lod);
        entry = this.createStructure(structure, faction);
        this.structureObjects.set(structure.id, entry);
      }
      entry.lod.position.copy(this.worldPosition(structure.position, 0));
      const active = structure.status === "active";
      const progress = active
        ? 1
        : clamp(structure.progress / Math.max(1, structure.requiredProgress), 0.08, 1);
      const base = structure.type === "camp" ? 0.92 : 1.02;
      entry.lod.scale.set(base, base * (0.28 + 0.72 * progress), base);
      for (const level of [entry.high, entry.medium, entry.low]) {
        level?.traverse?.((object) => {
          if (!object.isMesh) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            material.transparent = !active;
            material.opacity = active ? 1 : 0.52;
            material.depthWrite = active;
          }
        });
      }
    }
    for (const [id, entry] of this.structureObjects) {
      if (live.has(id)) continue;
      disposeObject(entry.lod);
      this.structureObjects.delete(id);
    }
  },
};
