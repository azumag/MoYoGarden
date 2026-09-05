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
    modelTimeoutMs: 9_000,
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

function networkIsConstrained() {
  const connection = globalThis.navigator?.connection;
  const effectiveType = String(connection?.effectiveType ?? "").toLowerCase();
  return Boolean(connection?.saveData) || ["slow-2g", "2g", "3g"].includes(effectiveType);
}

function safeModeRequested() {
  const quality = String(queryValue("quality") ?? "").toLowerCase();
  const renderer = String(queryValue("renderer") ?? "").toLowerCase();
  return quality === "low" || renderer === "compat" || queryValue("safe") === "1";
}

function automaticProfileId() {
  const memory = Number(globalThis.navigator?.deviceMemory ?? 0);
  const cores = Number(globalThis.navigator?.hardwareConcurrency ?? 0);
  const narrow = Number(globalThis.innerWidth ?? 1280) < 900;
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (networkIsConstrained() || narrow || reducedMotion || (memory > 0 && memory < 6) || (cores > 0 && cores < 6)) {
    return "balanced";
  }
  if (memory >= 12 && cores >= 10) return "ultra";
  if (memory >= 8 && cores >= 8) return "high";
  return "balanced";
}

function needsAutoConstraintTuning() {
  const memory = Number(globalThis.navigator?.deviceMemory ?? 0);
  const cores = Number(globalThis.navigator?.hardwareConcurrency ?? 0);
  const touchPoints = Number(globalThis.navigator?.maxTouchPoints ?? 0);
  const pixelRatio = Number(globalThis.devicePixelRatio ?? 1);
  const width = Number(globalThis.innerWidth ?? 1280);
  return (
    networkIsConstrained() ||
    (memory > 0 && memory < 4) ||
    (cores > 0 && cores < 4) ||
    (touchPoints > 0 && pixelRatio >= 2.5 && width < 1100)
  );
}

function tuneAutomaticBalancedProfile(profile, requested) {
  if (requested !== "auto" || profile.id !== "balanced" || !needsAutoConstraintTuning()) {
    return { ...profile, requested };
  }
  return {
    ...profile,
    requested,
    pixelRatioCap: Math.min(profile.pixelRatioCap, 1.1),
    antialias: false,
    shadowSize: Math.min(profile.shadowSize, 512),
    shadowRadius: Math.min(profile.shadowRadius, 1.8),
    shadowUpdateIntervalMs: Math.max(profile.shadowUpdateIntervalMs, 650),
    environmentSize: Math.min(profile.environmentSize, 32),
    modelTimeoutMs: networkIsConstrained() ? Math.max(profile.modelTimeoutMs, 12_000) : profile.modelTimeoutMs,
    detailDensity: Math.min(profile.detailDensity, 0.48),
    lodScale: Math.min(profile.lodScale, 0.74),
  };
}

function tuneSafeBalancedProfile(profile, requested) {
  return {
    ...profile,
    requested,
    label: "SAFE",
    pixelRatioCap: 1,
    antialias: false,
    shadowSize: 512,
    shadowRadius: 1.6,
    shadowUpdateIntervalMs: 900,
    environmentSize: 16,
    modelTimeoutMs: Math.max(profile.modelTimeoutMs, 12_000),
    modelConcurrency: 1,
    detailDensity: 0.32,
    lodScale: 0.64,
  };
}

export function resolveQualityProfile() {
  const requested = (queryValue("quality") || "auto").toLowerCase();
  if (safeModeRequested()) {
    return tuneSafeBalancedProfile(PROFILES.balanced, requested === "low" ? "low" : "safe");
  }
  const id = Object.hasOwn(PROFILES, requested) ? requested : automaticProfileId();
  return tuneAutomaticBalancedProfile(PROFILES[id], requested);
}

export function qualityProfileIds() {
  return Object.keys(PROFILES);
}
