import * as THREE from "three";

const MODEL_VERSION = "0.3.3";
const MODEL_MANIFEST = Object.freeze([
  ["settler", `/models/settler.glb?v=${MODEL_VERSION}`],
  ["buildings", `/models/buildings.glb?v=${MODEL_VERSION}`],
  ["tree", `/models/tree.glb?v=${MODEL_VERSION}`],
  ["rock", `/models/rock.glb?v=${MODEL_VERSION}`],
]);
const MAX_MODEL_BYTES = 8 * 1024 * 1024;

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
          const gltf = await loadWithTimeout(loader, key, url, timeoutMs);
          this.templates.set(key, this.prepareTemplate(gltf.scene));
          const result = { key, ok: true };
          results.push(result);
          onModelLoaded?.(result);
        } catch (error) {
          const result = {
            key,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
          results.push(result);
          console.warn(`MoYoGarden: ${key} glTF load failed; procedural LOD remains active`, error);
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

      object.geometry.userData.moyoShared = true;
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
      object.material = Array.isArray(object.material) ? materials : materials[0];
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return clone;
  }
}
