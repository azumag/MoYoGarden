import * as THREE from "three";

export const ROLE_LABELS = {
  builder: "建築家",
  woodcutter: "木こり",
  miner: "鉱夫",
  forager: "採集者",
  scout: "斥候",
  trader: "商人",
};

export const TERRAIN_COLORS = {
  plain: new THREE.Color(0x71845a),
  forest: new THREE.Color(0x49684a),
  hill: new THREE.Color(0x817764),
  water: new THREE.Color(0x39758a),
};

export const STRUCTURE_NAMES = {
  camp: "Camp",
  storehouse: "Storehouse",
  market: "Market",
  workshop: "Workshop",
};

export const WORLD_UP = new THREE.Vector3(0, 1, 0);
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, amount) => a + (b - a) * amount;

export function hash2(x, y, salt = 0) {
  let value = Math.imul((x + 101 + salt * 17) | 0, 374761393)
    ^ Math.imul((y + 173 + salt * 31) | 0, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

const BUILDING_SILHOUETTE_PROFILE = Object.freeze({
  camp: Object.freeze({ profile: "open-side", salt: 1301 }),
  storehouse: Object.freeze({ profile: "annex", salt: 1401 }),
  market: Object.freeze({ profile: "canopy", salt: 1501 }),
  workshop: Object.freeze({ profile: "stack", salt: 1601 }),
});

export function buildingSilhouetteVariant(type, position = {}) {
  const key = String(type || "storehouse").toLowerCase();
  const spec = BUILDING_SILHOUETTE_PROFILE[key] || BUILDING_SILHOUETTE_PROFILE.storehouse;
  const x = Number.isFinite(Number(position.x)) ? Number(position.x) : 0;
  const y = Number.isFinite(Number(position.y)) ? Number(position.y) : 0;
  const side = hash2(x, y, spec.salt) >= 0.5 ? 1 : -1;
  return Object.freeze({
    profile: spec.profile,
    side,
    roofTilt: (hash2(x, y, spec.salt + 1) - 0.5) * 0.14,
    offset: (hash2(x, y, spec.salt + 2) - 0.5) * 0.18,
    damageIndex: Math.min(2, Math.floor(hash2(x, y, spec.salt + 3) * 3)),
  });
}

export function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  root?.traverse?.((object) => {
    if (object.geometry && !object.geometry.userData?.moyoShared) geometries.add(object.geometry);
    if (!object.material) return;
    const values = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of values) {
      if (!material.userData?.moyoShared) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();
  root?.removeFromParent?.();
}

export function setObjectAgentId(root, id) {
  root.userData.agentId = id;
  root.traverse((object) => { object.userData.agentId = id; });
}

export function setShadows(root, cast = true, receive = true) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = cast;
    object.receiveShadow = receive;
  });
}
