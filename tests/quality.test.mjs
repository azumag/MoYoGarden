import assert from "node:assert/strict";
import test from "node:test";
import { resolveQualityProfile } from "../public/client/quality.js";

function replaceGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, previous);
  };
}

function withDevice(overrides, run) {
  const restores = [
    replaceGlobal("location", { search: overrides.search ?? "" }),
    replaceGlobal("navigator", {
      deviceMemory: overrides.memory ?? 8,
      hardwareConcurrency: overrides.cores ?? 8,
      maxTouchPoints: overrides.touchPoints ?? 0,
      connection: {
        effectiveType: overrides.effectiveType ?? "4g",
        saveData: overrides.saveData ?? false,
      },
    }),
    replaceGlobal("innerWidth", overrides.width ?? 1280),
    replaceGlobal("devicePixelRatio", overrides.pixelRatio ?? 1),
    replaceGlobal("matchMedia", () => ({ matches: overrides.reducedMotion ?? false })),
  ];
  try {
    run();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

test("auto quality trims high-DPR touch devices without changing the public profile id", () => {
  withDevice({ width: 390, pixelRatio: 3, touchPoints: 5 }, () => {
    const quality = resolveQualityProfile();
    assert.equal(quality.id, "balanced");
    assert.equal(quality.pixelRatioCap, 1.1);
    assert.equal(quality.antialias, false);
    assert.equal(quality.shadowSize, 512);
    assert.equal(quality.detailDensity, 0.48);
    assert.equal(quality.lodScale, 0.74);
  });
});

test("auto quality honors save-data or slow-network hints even on powerful desktops", () => {
  withDevice({ width: 1440, memory: 16, cores: 12, saveData: true }, () => {
    const quality = resolveQualityProfile();
    assert.equal(quality.id, "balanced");
    assert.equal(quality.modelTimeoutMs, 12_000);
    assert.equal(quality.environmentSize, 32);
  });
});

test("explicit quality selection remains an override for constrained devices", () => {
  withDevice({ search: "?quality=balanced", width: 390, pixelRatio: 3, touchPoints: 5 }, () => {
    const quality = resolveQualityProfile();
    assert.equal(quality.id, "balanced");
    assert.equal(quality.pixelRatioCap, 1.3);
    assert.equal(quality.antialias, true);
    assert.equal(quality.shadowSize, 1024);
    assert.equal(quality.detailDensity, 0.62);
  });
});
