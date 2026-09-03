const PROFILES = Object.freeze({
  balanced: Object.freeze({
    id: "balanced",
    label: "BALANCED",
    pixelRatioCap: 1.3,
    antialias: true,
    shadowSize: 1024,
    shadowRadius: 2.2,
    shadowUpdateIntervalMs: 420,
    environmentSize: 64,
    modelTimeoutMs: 7_000,
    modelConcurrency: 1,
    detailDensity: 0.62,
    lodScale: 0.86,
  }),
  high: Object.freeze({
    id: "high",
    label: "HIGH",
    pixelRatioCap: 1.65,
    antialias: true,
    shadowSize: 2048,
    shadowRadius: 2.8,
    shadowUpdateIntervalMs: 280,
    environmentSize: 128,
    modelTimeoutMs: 9_000,
    modelConcurrency: 2,
    detailDensity: 0.86,
    lodScale: 1,
  }),
  ultra: Object.freeze({
    id: "ultra",
    label: "ULTRA",
    pixelRatioCap: 2,
    antialias: true,
    shadowSize: 2048,
    shadowRadius: 3.2,
    shadowUpdateIntervalMs: 180,
    environmentSize: 256,
    modelTimeoutMs: 12_000,
    modelConcurrency: 2,
    detailDensity: 1,
    lodScale: 1.12,
  }),
});

function queryValue(name) {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(name);
  } catch {
    return null;
  }
}

function automaticProfileId() {
  const memory = Number(globalThis.navigator?.deviceMemory ?? 0);
  const cores = Number(globalThis.navigator?.hardwareConcurrency ?? 0);
  const narrow = Number(globalThis.innerWidth ?? 1280) < 900;
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (narrow || reducedMotion || (memory > 0 && memory < 6) || (cores > 0 && cores < 6)) {
    return "balanced";
  }
  if (memory >= 12 && cores >= 10) return "ultra";
  if (memory >= 8 && cores >= 8) return "high";
  return "balanced";
}

export function resolveQualityProfile() {
  const requested = (queryValue("quality") || "auto").toLowerCase();
  const id = Object.hasOwn(PROFILES, requested) ? requested : automaticProfileId();
  return { ...PROFILES[id], requested };
}

export function qualityProfileIds() {
  return Object.keys(PROFILES);
}
