import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
const url = new URL("../public/client/world-atmosphere.js", import.meta.url);
const feature = existsSync(url) ? await import(url) : {};
function view() {
  assert.equal(typeof feature.refreshAtmosphereSurfaces, "function", "atmosphere integration missing");
  const worldRoot = new THREE.Group();
  return { worldRoot, state: { regionId: "a" }, quality: { id: "high", label: "HIGH" } };
}
test("late neighboring surfaces are styled and rebase to the same world anchor", () => {
  const v = view();
  feature.refreshAtmosphereSurfaces(v);
  const group = new THREE.Group(); group.position.set(10, 0, 20);
  group.userData.moyoHexOrigin = { x: 110, y: 220 };
  const water = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
  water.name = "neighbor-hex-water"; group.add(water); v.worldRoot.add(group);
  feature.refreshAtmosphereSurfaces(v);
  assert.equal(water.material.userData.moyoSurfaceKind, "water");
  assert.deepEqual(v.moyoAtmosphereUniforms.origin.value.toArray(), [100, 200]);
});
test("surface extension leaves unrelated models and simulation state untouched", () => {
  const v = view(); const original = JSON.stringify(v.state);
  const material = new THREE.MeshStandardMaterial();
  v.worldRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  const hook = material.onBeforeCompile; feature.refreshAtmosphereSurfaces(v);
  assert.equal(material.onBeforeCompile, hook); assert.equal(JSON.stringify(v.state), original);
});
test("optional atmosphere loads after terrain/decay patches and before app", () => {
  const boot = readFileSync(new URL("../public/boot.js", import.meta.url), "utf8");
  const index = boot.indexOf('await import(`/client/world-atmosphere.js');
  assert.ok(index > boot.indexOf('await import(`/client/decay-dressing.js'));
  assert.ok(index < boot.indexOf('moduleScript.src ='));
});
test("new water is not overwritten by the legacy per-frame HSL cycle", () => {
  const source = readFileSync(new URL("../public/client/world-view.js", import.meta.url), "utf8");
  assert.match(source, /this.waterMesh && this.waterMesh.material.userData.moyoSurfaceKind !== "water"/);
});
test("reduced motion and SAFE freeze cosmetic animation without pausing simulation", () => {
  assert.equal(typeof feature.atmosphereTime, "function");
  assert.equal(feature.atmosphereTime(9000, false, "HIGH"), 9);
  assert.equal(feature.atmosphereTime(9000, true, "HIGH"), 0);
  assert.equal(feature.atmosphereTime(9000, false, "SAFE"), 0);
});
