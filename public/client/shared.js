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
  plain: new THREE.Color(0x658353),
  forest: new THREE.Color(0x315a35),
  hill: new THREE.Color(0x756b57),
  water: new THREE.Color(0x1c5266),
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

export function disposeObject(root) {
  root?.traverse?.((object) => {
    object.geometry?.dispose?.();
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose?.();
  });
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
