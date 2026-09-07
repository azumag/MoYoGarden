import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as THREE from "three";
import { createSurfaceUniforms } from "../public/client/surface-materials.js";
const url = new URL("../public/client/ground-cover.js", import.meta.url);
const feature = existsSync(url) ? await import(url) : {};
function build(height = 0.2, structures = [], label = "HIGH") {
  assert.equal(typeof feature.createGroundCover, "function", "ground cover is missing");
  const geometry = new THREE.PlaneGeometry(8, 8, 8, 8);
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, height, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const state = { seed: 42, width: 16, height: 16, structures };
  const original = JSON.stringify(state);
  const result = feature.createGroundCover(mesh, state, { label, id: "high", detailDensity: 0.86 }, createSurfaceUniforms());
  assert.equal(JSON.stringify(state), original);
  return result;
}
test("ground cover is deterministic, bounded and batched", () => {
  const a = build(), b = build();
  assert.ok(a?.isInstancedMesh);
  assert.ok(a.count > 30 && a.count <= 1400);
  assert.equal(a.castShadow, false);
  assert.deepEqual(Array.from(a.instanceMatrix.array), Array.from(b.instanceMatrix.array));
  assert.equal(a.material.map, null);
});
test("ground cover rests on the actual mesh, not a guessed tile height", () => {
  const cover = build(0.37);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < cover.count; i++) {
    cover.getMatrixAt(i, matrix);
    assert.ok(Math.abs(matrix.elements[13] - 0.373) < 0.0001);
    assert.ok(Math.abs(matrix.elements[12]) <= 4);
    assert.ok(Math.abs(matrix.elements[14]) <= 4);
  }
});
test("submerged surfaces and SAFE mode do not allocate grass meshes", () => {
  assert.equal(build(-0.24), null);
  assert.equal(build(0.2, [], "SAFE"), null);
});
test("occupied building cells are excluded from cosmetic ground cover", async () => {
  const { worldXZToHexTile } = await import("../public/client/hex-grid.js");
  const occupied = { x: 8, y: 8 };
  const cover = build(0.2, [{ position: occupied }]);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < cover.count; i++) {
    cover.getMatrixAt(i, matrix);
    const tile = worldXZToHexTile(matrix.elements[12], matrix.elements[14], 16, 16);
    assert.notDeepEqual(tile, occupied);
  }
});
