import * as THREE from "three";
import { STRUCTURE_NAMES, clamp, disposeObject, hash2, setShadows } from "./shared.js";

function makeMaterial(color, roughness = 0.86, metalness = 0, emissive = null) {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  if (emissive !== null) {
    material.emissive = new THREE.Color(emissive);
    material.emissiveIntensity = 1.05;
  }
  return material;
}

function addPart(group, geometry, material, position, rotation = null, scale = null, name = "") {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  if (scale) mesh.scale.set(...scale);
  if (name) mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function paletteFor(factionColor) {
  const faction = new THREE.Color(factionColor || "#8a8f8c");
  return {
    faction: faction.clone().lerp(new THREE.Color(0x5d625c), 0.36),
    factionDark: faction.clone().lerp(new THREE.Color(0x30342f), 0.58),
    timber: new THREE.Color(0x60452f),
    timberDark: new THREE.Color(0x3d3025),
    stone: new THREE.Color(0x77786f),
    plaster: new THREE.Color(0x9b927e),
    metal: new THREE.Color(0x656a69),
  };
}

function addPost(group, material, x, z, height = 1.15) {
  return addPart(group, new THREE.CylinderGeometry(0.035, 0.05, height, 8), material, [x, height * 0.5, z]);
}

function addCrate(group, material, x, y, z, scale = 1) {
  const crate = addPart(group, new THREE.BoxGeometry(0.28, 0.24, 0.28), material, [x, y, z], [0, x * 0.35 + z * 0.21, 0], [scale, scale, scale]);
  const bandMaterial = makeMaterial(0x393934, 0.55, 0.22);
  addPart(crate, new THREE.BoxGeometry(0.032, 0.25, 0.292), bandMaterial, [0, 0, 0]);
  return crate;
}

function addBarrel(group, material, x, z) {
  const barrel = addPart(group, new THREE.CylinderGeometry(0.15, 0.17, 0.34, 12), material, [x, 0.19, z]);
  const band = makeMaterial(0x3d4241, 0.44, 0.42);
  for (const y of [-0.11, 0.11]) addPart(barrel, new THREE.TorusGeometry(0.158, 0.012, 5, 12), band, [0, y, 0], [Math.PI / 2, 0, 0]);
  return barrel;
}

function decorateBuildingModel(root, type, factionColor, detail = "high") {
  if (!root || root.getObjectByName("MoyoArchitecture")) return root;
  const palette = paletteFor(factionColor);
  const group = new THREE.Group();
  group.name = "MoyoArchitecture";

  const timber = makeMaterial(palette.timber, 0.91);
  const timberDark = makeMaterial(palette.timberDark, 0.93);
  const stone = makeMaterial(palette.stone, 0.97);
  const plaster = makeMaterial(palette.plaster, 0.95);
  const faction = makeMaterial(palette.faction, 0.82);
  const factionDark = makeMaterial(palette.factionDark, 0.86);
  const metal = makeMaterial(palette.metal, 0.4, 0.5);

  addPart(group, new THREE.BoxGeometry(1.48, 0.12, 1.2), stone, [0, 0.06, 0], null, null, "MoyoPlinth");
  addPart(group, new THREE.BoxGeometry(0.58, 0.1, 0.28), stone, [0, 0.13, 0.68], null, null, "MoyoFrontStep");

  if (type !== "camp") {
    for (const x of [-0.62, 0.62]) addPost(group, timberDark, x, 0.49, 1.22);
    addPart(group, new THREE.BoxGeometry(1.34, 0.075, 0.09), timberDark, [0, 1.23, 0.49]);
  }

  if (type === "camp") {
    const awning = addPart(group, new THREE.BoxGeometry(1.25, 0.035, 0.78), faction, [0.52, 1.08, -0.08], [0, 0, -0.13], null, "MoyoCampAwning");
    awning.castShadow = true;
    addPost(group, timberDark, 1.05, 0.23, 1.02);
    addPost(group, timberDark, 1.05, -0.39, 0.95);
    addPart(group, new THREE.CylinderGeometry(0.1, 0.115, 0.7, 9), timber, [-0.78, 0.22, -0.3], [0, 0, Math.PI / 2], null, "MoyoLogPileA");
    addPart(group, new THREE.CylinderGeometry(0.09, 0.105, 0.62, 9), timber, [-0.73, 0.29, -0.18], [0.15, 0.12, Math.PI / 2], null, "MoyoLogPileB");
    if (detail === "high") {
      addPart(group, new THREE.BoxGeometry(0.56, 0.045, 0.34), factionDark, [-0.3, 0.09, -0.67], [0, -0.16, 0], null, "MoyoBedroll");
      addPart(group, new THREE.CylinderGeometry(0.055, 0.055, 1.4, 8), timberDark, [-0.88, 0.7, 0.32]);
      addPart(group, new THREE.PlaneGeometry(0.45, 0.26), faction, [-0.66, 1.14, 0.32], [0, 0.08, 0], null, "MoyoCampBanner");
    }
  } else if (type === "storehouse") {
    addPart(group, new THREE.BoxGeometry(1.3, 0.065, 0.52), factionDark, [0, 1.24, 0.67], [-0.11, 0, 0], null, "MoyoStoreAwning");
    addPost(group, timber, -0.54, 0.82, 1.17);
    addPost(group, timber, 0.54, 0.82, 1.17);
    addCrate(group, timber, 0.68, 0.2, 0.63, 1.08);
    addBarrel(group, timber, -0.69, 0.62);
    if (detail === "high") {
      addCrate(group, timberDark, 0.87, 0.16, 0.25, 0.82);
      addPart(group, new THREE.BoxGeometry(1.05, 0.055, 0.06), timberDark, [0, 0.74, -0.575], [0, 0, 0.42], null, "MoyoRearBraceA");
      addPart(group, new THREE.BoxGeometry(1.05, 0.055, 0.06), timberDark, [0, 0.74, -0.575], [0, 0, -0.42], null, "MoyoRearBraceB");
    }
  } else if (type === "market") {
    addPart(group, new THREE.BoxGeometry(1.72, 0.055, 1.2), faction, [0, 1.44, 0], [0.02, 0, 0.015], null, "MoyoMarketCanopy");
    for (const x of [-0.74, 0.74]) for (const z of [-0.48, 0.48]) addPost(group, timberDark, x, z, 1.42);
    addPart(group, new THREE.BoxGeometry(1.28, 0.12, 0.34), timber, [0, 0.55, 0.46], null, null, "MoyoMarketCounter");
    addPart(group, new THREE.BoxGeometry(0.46, 0.34, 0.055), timberDark, [0, 1.18, 0.62], [0, 0, 0.02], null, "MoyoMarketSign");
    if (detail === "high") {
      addCrate(group, timber, -0.53, 0.2, -0.3, 0.92);
      addCrate(group, timberDark, 0.5, 0.19, -0.25, 0.86);
      const lantern = makeMaterial(0xe2a64a, 0.5, 0.06, 0xffa13c);
      for (const x of [-0.55, 0.55]) addPart(group, new THREE.SphereGeometry(0.06, 8, 6), lantern, [x, 1.24, 0.5], null, [0.8, 1.12, 0.8], "MoyoMarketLantern");
    }
  } else {
    addPart(group, new THREE.BoxGeometry(1.16, 0.06, 0.48), metal, [0.05, 1.34, 0.62], [-0.14, 0, 0], null, "MoyoWorkshopLeanTo");
    addPost(group, timberDark, -0.48, 0.82, 1.25);
    addPost(group, timberDark, 0.58, 0.82, 1.25);
    addPart(group, new THREE.CylinderGeometry(0.13, 0.17, 1.42, 12), stone, [0.48, 1.34, -0.28], null, null, "MoyoTallChimney");
    addPart(group, new THREE.CylinderGeometry(0.19, 0.16, 0.09, 12), metal, [0.48, 2.05, -0.28], null, null, "MoyoChimneyCap");
    if (detail === "high") {
      const forge = makeMaterial(0x5f4433, 0.92, 0, 0xff5d27);
      addPart(group, new THREE.BoxGeometry(0.46, 0.3, 0.38), plaster, [0.75, 0.24, 0.24], null, null, "MoyoForgeBase");
      addPart(group, new THREE.BoxGeometry(0.31, 0.06, 0.24), forge, [0.75, 0.42, 0.24], null, null, "MoyoForgeGlow");
      addBarrel(group, timber, -0.72, 0.58);
      addPart(group, new THREE.BoxGeometry(0.58, 0.12, 0.3), timber, [-0.62, 0.4, -0.42], null, null, "MoyoWorkbench");
    }
  }

  if (detail === "high" && type !== "camp") {
    const trimY = type === "market" ? 1.47 : 1.49;
    addPart(group, new THREE.BoxGeometry(1.56, 0.055, 0.06), timberDark, [0, trimY, 0.56], [0, 0, 0.03], null, "MoyoRoofTrimFront");
    addPart(group, new THREE.BoxGeometry(1.56, 0.055, 0.06), timberDark, [0, trimY, -0.56], [0, 0, -0.03], null, "MoyoRoofTrimRear");
  }

  root.add(group);
  setShadows(group);
  return root;
}

function structureFacingRotation(structure, state) {
  const neighbors = state.structures
    .filter((value) => value.id !== structure.id && value.factionId === structure.factionId)
    .map((value) => ({
      value,
      distance: Math.hypot(
        value.position.x - structure.position.x,
        value.position.y - structure.position.y,
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
  const target = neighbors[0]?.value;
  if (!target) {
    return hash2(structure.position.x, structure.position.y, 120) > 0.5 ? 0 : Math.PI / 2;
  }
  return Math.atan2(
    target.position.x - structure.position.x,
    target.position.y - structure.position.y,
  );
}

export const structureMethods = {
  makeLowBuilding(type, factionColor) {
    const group = new THREE.Group();
    const colors = paletteFor(factionColor);
    const wallColor = type === "workshop"
      ? colors.stone
      : type === "market" ? new THREE.Color(0x946844) : type === "camp" ? new THREE.Color(0x8a755a) : new THREE.Color(0x7a5d40);
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry(1.42, 0.14, 1.15),
      makeMaterial(colors.stone, 0.97),
    );
    foundation.position.y = 0.07;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.84, 0.94),
      makeMaterial(wallColor, 0.88),
    );
    body.position.y = 0.54;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.94, 0.5, 4),
      makeMaterial(colors.faction, 0.8),
    );
    roof.position.y = 1.17;
    roof.rotation.y = Math.PI / 4;
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.46, 0.035),
      makeMaterial(colors.timberDark, 0.92),
    );
    door.position.set(0, 0.35, 0.49);
    group.add(foundation, body, roof, door);
    if (type === "workshop") addPart(group, new THREE.CylinderGeometry(0.11, 0.14, 0.9, 8), makeMaterial(colors.stone, 0.97), [0.4, 1.15, -0.26]);
    setShadows(group);
    return group;
  },

  createStructure(structure, faction, state) {
    const childName = STRUCTURE_NAMES[structure.type] || "Storehouse";
    const high = decorateBuildingModel(this.models.clone("buildings", {
      childName,
      factionColor: faction.color,
      detail: "high",
    }), structure.type, faction.color, "high");
    const medium = decorateBuildingModel(this.models.clone("buildings", {
      childName,
      factionColor: faction.color,
      detail: "mid",
    }), structure.type, faction.color, "mid");
    const low = this.makeLowBuilding(structure.type, faction.color);
    const lod = this.createLod(high, medium, low, [0, 22, 46]);
    lod.userData.structureId = structure.id;
    lod.rotation.y = structureFacingRotation(structure, state);
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
        entry = this.createStructure(structure, faction, state);
        this.structureObjects.set(structure.id, entry);
      }
      entry.lod.position.copy(this.worldPosition(structure.position, 0));
      entry.lod.rotation.y = structureFacingRotation(structure, state);
      const active = structure.status === "active";
      const progress = active
        ? 1
        : clamp(structure.progress / Math.max(1, structure.requiredProgress), 0.08, 1);
      const base = structure.type === "camp"
        ? 0.98
        : structure.type === "market" ? 1.08 : structure.type === "workshop" ? 1.12 : 1.1;
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
