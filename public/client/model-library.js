import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_MANIFEST = Object.freeze({
  settler: "/models/settler.glb",
  tree: "/models/tree.glb",
  rock: "/models/rock.glb",
  buildings: "/models/buildings.glb",
});

const DEFAULT_MODEL_TIMEOUT_MS = 7_000;
const MAX_MODEL_BYTES = 8 * 1024 * 1024;

function isLowQualityMode() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("quality") === "low";
  } catch {
    return false;
  }
}

async function loadModelWithTimeout(loader, key, url, timeoutMs) {
  const controller = new AbortController();
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${key} model timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const load = (async () => {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "force-cache",
      headers: { accept: "model/gltf-binary, application/octet-stream;q=0.9, */*;q=0.1" },
    });
    if (!response.ok) {
      throw new Error(`${key} model returned HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_BYTES) {
      throw new Error(`${key} model is unexpectedly large (${declaredLength} bytes)`);
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MODEL_BYTES) {
      throw new Error(`${key} model has an invalid size (${bytes.byteLength} bytes)`);
    }

    const basePath = new URL(".", new URL(url, globalThis.location?.href ?? "http://localhost/")).href;
    return loader.parseAsync(bytes, basePath);
  })();

  try {
    return await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ModelLibrary {
  constructor() {
    this.loader = new GLTFLoader();
    this.templates = new Map();
    this.lastLoadResult = { loaded: [], failed: [], skipped: false };
  }

  async load({ timeoutMs = DEFAULT_MODEL_TIMEOUT_MS, onProgress } = {}) {
    if (isLowQualityMode()) {
      this.lastLoadResult = {
        loaded: [],
        failed: [],
        skipped: true,
      };
      return this.lastLoadResult;
    }

    const entries = Object.entries(MODEL_MANIFEST);
    let completed = 0;
    const results = await Promise.all(entries.map(async ([key, url]) => {
      try {
        const gltf = await loadModelWithTimeout(this.loader, key, url, timeoutMs);
        this.templates.set(key, gltf.scene);
        return { key, ok: true };
      } catch (error) {
        console.warn(`MoYoGarden: ${key} glTF load failed; fallback LOD will be used`, error);
        return {
          key,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        completed += 1;
        onProgress?.({ key, completed, total: entries.length });
      }
    }));

    this.lastLoadResult = {
      loaded: results.filter((result) => result.ok).map((result) => result.key),
      failed: results.filter((result) => !result.ok).map((result) => ({
        key: result.key,
        message: result.message,
      })),
      skipped: false,
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
