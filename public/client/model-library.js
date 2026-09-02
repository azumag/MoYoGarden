import * as THREE from "three";

const MODEL_VERSION = "0.3.4";
const AUTHORED_VERSION = "0.3.7";
const AUTHORED_BUILDING_VERSION = "0.3.10";
const MODEL_MANIFEST = Object.freeze([
  ["settler", `/models/settler.glb?v=${MODEL_VERSION}`],
  ["buildings", `/models/buildings.glb?v=${MODEL_VERSION}`],
  ["tree", `/models/tree.glb?v=${MODEL_VERSION}`],
  ["rock", `/models/rock.glb?v=${MODEL_VERSION}`],
  ["authored:building-camp", `/assets/authored/kaykit/camp.glb?v=${AUTHORED_BUILDING_VERSION}`],
  ["authored:building-storehouse", `/assets/authored/kaykit/storehouse.glb?v=${AUTHORED_BUILDING_VERSION}`],
  ["authored:building-market", `/assets/authored/kaykit/market.glb?v=${AUTHORED_BUILDING_VERSION}`],
  ["authored:building-workshop", `/assets/authored/kaykit/workshop.glb?v=${AUTHORED_BUILDING_VERSION}`],
  ["authored:tree-oak", `/assets/authored/kenney/tree_oak.glb?v=${AUTHORED_VERSION}`],
  ["authored:tree-pine", `/assets/authored/kenney/tree_pine.glb?v=${AUTHORED_VERSION}`],
  ["authored:rock-large", `/assets/authored/kenney/rock_large.glb?v=${AUTHORED_VERSION}`],
  ["authored:rock-medium", `/assets/authored/kenney/rock_medium.glb?v=${AUTHORED_VERSION}`],
  ["authored:rock-small", `/assets/authored/kenney/rock_small.glb?v=${AUTHORED_VERSION}`],
]);
const MAX_MODEL_BYTES = 8 * 1024 * 1024;
const AUTHORED_BUILDING_BY_CHILD = Object.freeze({
  Camp: "authored:building-camp",
  Storehouse: "authored:building-storehouse",
  Market: "authored:building-market",
  Workshop: "authored:building-workshop",
});
const AUTHORED_BUILDING_HEIGHT = Object.freeze({
  "authored:building-camp": 1.62,
  "authored:building-storehouse": 1.82,
  "authored:building-market": 1.72,
  "authored:building-workshop": 1.88,
});

function isAuthoredKey(key) {
  return key.startsWith("authored:");
}

function refreshKeyFor(key) {
  if (key.startsWith("authored:building-")) return "buildings";
  if (key.startsWith("authored:tree-")) return "tree";
  if (key.startsWith("authored:rock-")) return "rock";
  return key;
}

function validateGlb(bytes, key) {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_MODEL_BYTES) {
    throw new Error(`${key} model has an invalid size (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${key} is not a GLB file`);
  if (view.getUint32(4, true) !== 2) throw new Error(`${key} is not glTF 2.0`);
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error(`${key} GLB length is invalid`);
}

async function loadWithTimeout(loader, key, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "force-cache",
      headers: {
        accept: "model/gltf-binary, application/octet-stream;q=0.9, */*;q=0.1",
      },
    });
    if (!response.ok) throw new Error(`${key} model returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_BYTES) {
      throw new Error(`${key} model is unexpectedly large (${declaredLength} bytes)`);
    }
    const bytes = await response.arrayBuffer();
    validateGlb(bytes, key);
    const basePath = new URL(".", new URL(url, location.href)).href;
    return loader.parseAsync(bytes, basePath);
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${key} model timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function authoredStandardMaterial(material, detail) {
  if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
    const copy = material.clone();
    copy.envMapIntensity = detail === "high" ? 0.72 : 0.52;
    return copy;
  }
  const color = material.color?.clone?.() || new THREE.Color(0xffffff);
  const name = material.name || "AuthoredMaterial";
  const lower = name.toLowerCase();
  const roughness = lower.includes("leaf") ? 0.84
    : lower.includes("wood") || lower.includes("bark") ? 0.9
      : lower.includes("rock") || lower.includes("stone") ? 0.94 : 0.88;
  const copy = new THREE.MeshStandardMaterial({
    name,
    color,
    map: material.map || null,
    transparent: Boolean(material.transparent),
    opacity: material.opacity ?? 1,
    alphaTest: material.alphaTest ?? 0,
    side: material.side ?? THREE.FrontSide,
    vertexColors: Boolean(material.vertexColors),
    roughness,
    metalness: 0,
    envMapIntensity: detail === "high" ? 0.68 : 0.48,
  });
  copy.userData = { ...(material.userData || {}), moyoPromotedFromUnlit: true };
  return copy;
}

function fitAuthoredBuilding(root, sourceName) {
  const targetHeight = AUTHORED_BUILDING_HEIGHT[sourceName];
  if (!root || !targetHeight) return root;
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
  root.userData.moyoAuthoredBuilding = true;
  root.userData.moyoModelKey = sourceName;
  return root;
}

export class ModelLibrary {
  constructor() {
    this.loaderPromise = null;
    this.templates = new Map();
    this.lastLoadResult = { loaded: [], failed: [] };
  }

  get size() {
    return MODEL_MANIFEST.length;
  }

  has(name) {
    return this.templates.has(name);
  }

  async getLoader() {
    if (!this.loaderPromise) {
      this.loaderPromise = import("three/addons/loaders/GLTFLoader.js")
        .then(({ GLTFLoader }) => new GLTFLoader());
    }
    return this.loaderPromise;
  }

  prepareTemplate(scene) {
    scene.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.userData.moyoShared = true;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return scene;
  }

  async load({ timeoutMs = 8_000, concurrency = 2, onProgress, onModelLoaded } = {}) {
    const queue = [...MODEL_MANIFEST];
    const results = [];
    let completed = 0;
    const worker = async () => {
      while (queue.length > 0) {
        const [key, url] = queue.shift();
        try {
          const loader = await this.getLoader();
          const itemTimeoutMs = isAuthoredKey(key) ? Math.min(timeoutMs, 2_500) : timeoutMs;
          const gltf = await loadWithTimeout(loader, key, url, itemTimeoutMs);
          this.templates.set(key, this.prepareTemplate(gltf.scene));
          const result = { key, ok: true };
          results.push(result);
          onModelLoaded?.({ ...result, key: refreshKeyFor(key), modelKey: key });
        } catch (error) {
          const result = {
            key,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
          results.push(result);
          const optional = isAuthoredKey(key);
          console[optional ? "info" : "warn"](
            `MoYoGarden: ${key} glTF load failed; ${optional ? "authored override skipped" : "procedural LOD remains active"}`,
            error,
          );
        } finally {
          completed += 1;
          onProgress?.({ key, completed, total: MODEL_MANIFEST.length });
        }
      }
    };
    const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, MODEL_MANIFEST.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    this.lastLoadResult = {
      loaded: results.filter((result) => result.ok).map((result) => result.key),
      failed: results.filter((result) => !result.ok).map((result) => ({
        key: result.key,
        message: result.message,
      })),
    };
    return this.lastLoadResult;
  }

  resolveSourceName(name, childName) {
    if (name === "buildings" && childName) {
      const authoredKey = AUTHORED_BUILDING_BY_CHILD[childName];
      if (authoredKey && this.templates.has(authoredKey)) return authoredKey;
    }
    return name;
  }

  source(name, childName) {
    const sourceName = this.resolveSourceName(name, childName);
    const root = this.templates.get(sourceName);
    if (!root) return null;
    if (sourceName !== name) return root;
    return childName ? root.getObjectByName(childName) : root;
  }

  clone(name, { childName, factionColor, role, detail = "high" } = {}) {
    const sourceName = this.resolveSourceName(name, childName);
    const source = this.source(name, childName);
    if (!source) return null;
    const clone = source.clone(true);
    const faction = new THREE.Color(factionColor || 0xffffff);
    const mutedFaction = faction.clone().lerp(new THREE.Color(0x343936), 0.28);
    const authored = sourceName.startsWith("authored:");

    clone.traverse((object) => {
      if ((object.userData.moyoDetail || object.name.startsWith("detail_")) && detail !== "high") {
        object.visible = false;
      }
      if (object.name.startsWith("Role_")) {
        object.visible = detail === "high" && object.name.startsWith(`Role_${role}_`);
      }
      if (!object.isMesh) return;

      object.geometry.userData.moyoShared = true;
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const materials = sourceMaterials.map((material) => {
        const copy = authored ? authoredStandardMaterial(material, detail) : material.clone();
        if (copy.name.includes("Faction")) {
          const baseColor = copy.color.clone();
          const strength = copy.name.includes("Dark") ? 0.52 : 0.3;
          copy.color.copy(mutedFaction).lerp(baseColor, strength);
          copy.roughness = Math.max(0.64, copy.roughness ?? 0.8);
          copy.metalness = Math.min(0.05, copy.metalness ?? 0);
        }
        copy.envMapIntensity = detail === "high" ? 0.72 : 0.52;
        return copy;
      });
      object.material = Array.isArray(object.material) ? materials : materials[0];
      object.castShadow = true;
      object.receiveShadow = true;
    });

    clone.userData.moyoModelKey = sourceName;
    if (sourceName.startsWith("authored:building-")) fitAuthoredBuilding(clone, sourceName);
    return clone;
  }
}
