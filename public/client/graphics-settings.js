// Versioned, allow-listed, browser-local rendering preferences. Never store tokens.
export const GRAPHICS_STORAGE_KEY = 'moyo-graphics-v1';
export const GRAPHICS_OPTIONS = Object.freeze({
  preset: ['auto', 'low', 'balanced', 'high', 'ultra'],
  resolution: ['auto', '0.75', '1', '1.5', '2'],
  shadows: ['auto', 'off', '512', '1024', '2048'],
  water: ['auto', 'simple', 'ripples'],
  vegetation: ['auto', 'off', 'sparse', 'full'],
  fps: ['auto', '30', '60'],
});

export function normalizeGraphicsSettings(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = { version: 1 };
  for (const [key, options] of Object.entries(GRAPHICS_OPTIONS)) {
    result[key] = Object.hasOwn(source, key) && options.includes(source[key]) ? source[key] : 'auto';
  }
  return result;
}

export function readGraphicsSettings(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const raw = target?.getItem(GRAPHICS_STORAGE_KEY);
    if (!raw || raw.length > 4096) return normalizeGraphicsSettings();
    const parsed = JSON.parse(raw);
    return normalizeGraphicsSettings(parsed?.version === 1 ? parsed : null);
  } catch {
    return normalizeGraphicsSettings();
  }
}

export function saveGraphicsSettings(settings, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target) return false;
    target.setItem(GRAPHICS_STORAGE_KEY, JSON.stringify(normalizeGraphicsSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

export function clearGraphicsSettings(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target) return false;
    target.removeItem(GRAPHICS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function graphicsSettingsUrl(href) {
  const url = new URL(href);
  for (const key of ['quality', 'safe', 'renderer']) url.searchParams.delete(key);
  return url.href;
}

export function applyGraphicsOverrides(profile, input, lockSafe = false) {
  const settings = normalizeGraphicsSettings(lockSafe ? null : input);
  const light = profile.label === 'SAFE';
  const result = { ...profile, shadowsEnabled: !light, environmentEnabled: !light,
    loadModels: !light, waterQuality: light ? 'simple' : 'ripples', frameRate: light ? 30 : 60 };
  if (light) result.detailDensity = 0;
  if (settings.resolution !== 'auto') {
    result.pixelRatioCap = Number(settings.resolution);
    if (result.pixelRatioCap <= 1) result.antialias = false;
  }
  if (settings.shadows !== 'auto') {
    result.shadowsEnabled = settings.shadows !== 'off';
    if (result.shadowsEnabled) result.shadowSize = Number(settings.shadows);
  }
  if (settings.water !== 'auto') result.waterQuality = settings.water;
  if (settings.vegetation !== 'auto') {
    result.detailDensity = { off: 0, sparse: 0.25, full: 1 }[settings.vegetation];
  }
  if (settings.fps !== 'auto') result.frameRate = Number(settings.fps);
  return result;
}

// Retain the remainder to avoid turning 60fps into 48fps on a 144Hz display.
export function frameIsDue(clock, time, fps = 60, hidden = false) {
  if (hidden) { clock.last = undefined; return false; }
  const interval = 1000 / (fps === 30 ? 30 : 60);
  if (!Number.isFinite(clock.last) || time < clock.last) { clock.last = time; return true; }
  const elapsed = time - clock.last;
  if (elapsed + 0.01 < interval) return false;
  clock.last = time - ((elapsed + 0.01) % interval);
  return true;
}

export function commitGraphicsSettings(settings, { storage, href, navigate, reset = false }) {
  const destination = graphicsSettingsUrl(href);
  const saved = reset ? clearGraphicsSettings(storage) : saveGraphicsSettings(settings, storage);
  if (!saved) return false;
  navigate(destination);
  return true;
}
