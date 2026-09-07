import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createWanderer, styleWastelandAsset } from '../public/client/wasteland-models.js';
import { disposeObject } from '../public/client/shared.js';

for (const role of ['builder', 'miner', 'woodcutter', 'forager', 'scout', 'trader']) {
  test(`${role} keeps a slender grounded silhouette at every LOD with bounded draws`, () => {
    const heights = [];
    for (const detail of ['high', 'mid', 'low']) {
      const root = createWanderer('#578ba3', role, detail);
      const box = new THREE.Box3().setFromObject(root), size = new THREE.Vector3(); box.getSize(size);
      heights.push(size.y);
      assert.ok(size.y > 1.85 && size.y < 2.1);
      assert.ok(size.x / size.y < 0.34);
      assert.ok(Math.abs(box.min.y) < 0.02);
      let draws = 0, triangles = 0;
      root.traverse(object => { if (object.isMesh) { draws++; triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3; } });
      assert.ok(draws <= (detail === 'low' ? 2 : 6), `${draws} draws`);
      assert.ok(triangles < 2200, `${triangles} triangles`);
      if (detail !== 'low') for (const name of ['FactionTorso', 'LeftLegPivot', 'RightLegPivot', 'LeftArmPivot', 'RightArmPivot']) assert.ok(root.getObjectByName(name));
      assert.ok(root.getObjectByName('MoyoAgentSilhouette'));
      disposeObject(root);
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) < 0.03);
  });
}

test('clones share bounded geometry but keep independently disposable faction materials', () => {
  const a = createWanderer('#ff5555'), b = createWanderer('#5555ff');
  const aBody = a.getObjectByName('FactionTorso').children[0];
  const bBody = b.getObjectByName('FactionTorso').children[0];
  assert.equal(aBody.geometry, bBody.geometry);
  let releasedShared = false, releasedBand = false;
  aBody.geometry.addEventListener('dispose', () => { releasedShared = true; });
  a.getObjectByName('MoyoFactionBand').material.addEventListener('dispose', () => { releasedBand = true; });
  assert.notEqual(a.getObjectByName('MoyoFactionBand').material, b.getObjectByName('MoyoFactionBand').material);
  disposeObject(a);
  assert.equal(releasedShared, false); assert.equal(releasedBand, true);
});

test('asset finish is idempotent and preserves geometry and texture maps', () => {
  const map = new THREE.Texture();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#32ee11', map, roughness: 0.2 }));
  const geometry = mesh.geometry;
  styleWastelandAsset(mesh, 'tree'); const first = mesh.material.color.clone();
  styleWastelandAsset(mesh, 'tree');
  assert.equal(mesh.geometry, geometry); assert.equal(mesh.material.map, map);
  assert.ok(mesh.material.color.equals(first)); assert.ok(mesh.material.roughness >= 0.93);
});
