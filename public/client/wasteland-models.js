import * as THREE from 'three';

const ROLES = ['builder', 'miner', 'woodcutter', 'forager', 'scout', 'trader'];
const templates = new Map();
const PALETTE = { cloth: 0x78715c, dark: 0x45483f, skin: 0x9d8066,
  leather: 0x574431, wrap: 0xa39b7a, iron: 0x62594e, rust: 0x78523c };
const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true,
  roughness: 0.94, metalness: 0.04, envMapIntensity: 0.28 });
bodyMaterial.userData = { moyoShared: true, moyoDecayStyled: true };
const bandGeometry = new THREE.BoxGeometry(0.12, 0.036, 0.075);
bandGeometry.userData.moyoShared = true;

// Bake rigid pieces into one vertex-coloured mesh per animated joint. This keeps
// a detailed silhouette at six draws, rather than a draw per buckle or bandage.
function bake(parts) {
  const positions = [], normals = [], colors = [];
  for (const [source, hex] of parts) {
    const geometry = source.index ? source.toNonIndexed() : source;
    const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    const color = new THREE.Color(hex);
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      colors.push(color.r, color.g, color.b);
    }
    geometry.dispose();
    if (source !== geometry) source.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.moyoShared = true;
  return geometry;
}

function part(geometry, color, x, y, z, scale = [1, 1, 1], tilt = 0) {
  geometry.scale(...scale).rotateZ(tilt).translate(x, y, z);
  return [geometry, color];
}

function buildTemplate(role, detail) {
  const high = detail === 'high', low = detail === 'low';
  const sides = high ? 7 : 5;
  const cylinder = (top, bottom, height) => new THREE.CylinderGeometry(top, bottom, height, sides);
  const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  const torsoY = 1.05; // Contract with the existing gait/breathing animation.
  const torso = [
    part(cylinder(0.19, 0.135, 0.48), PALETTE.cloth, 0, 1.36 - torsoY, 0, [1, 1, 0.62]),
    part(cylinder(0.13, 0.175, 0.30), PALETTE.dark, 0, 1.00 - torsoY, 0, [1, 1, 0.65]),
    part(cylinder(0.052, 0.061, 0.12), PALETTE.skin, 0, 1.64 - torsoY, 0),
    part(new THREE.SphereGeometry(0.117, high ? 8 : 6, high ? 6 : 4), PALETTE.skin,
      0, 1.80 - torsoY, 0, [0.83, 1.16, 0.9]),
    part(cylinder(0.09, 0.12, 0.075), PALETTE.wrap, 0, 1.655 - torsoY, 0.004, [1, 1, 0.76]),
    part(box(0.29, 0.045, 0.19), PALETTE.leather, 0, 1.115 - torsoY, 0),
  ];
  if (['trader', 'forager', 'builder'].includes(role)) {
    torso.push(part(cylinder(0.235, 0.235, 0.023), PALETTE.wrap, 0, 1.90 - torsoY, 0));
    torso.push(part(cylinder(0.085, 0.13, 0.105), PALETTE.dark, 0, 1.954 - torsoY, 0));
  } else {
    torso.push(part(cylinder(0.10, 0.115, 0.08), role === 'miner' ? PALETTE.iron : PALETTE.wrap,
      0, 1.88 - torsoY, 0, [1, 1, 0.9]));
  }
  if (!low) {
    torso.push(part(box(0.035, 0.48, 0.02), PALETTE.leather, 0, 1.365 - torsoY, 0.12, [1, 1, 1], -0.35));
    torso.push(part(box(0.25, 0.32, 0.13), PALETTE.leather, 0, 1.39 - torsoY, -0.15));
    torso.push(part(box(0.15, 0.31, 0.018), PALETTE.cloth, -0.085, 0.91 - torsoY, -0.09, [1, 1, 1], 0.08));
  }
  if (high) {
    torso.push(part(box(0.10, 0.12, 0.07), PALETTE.leather, 0.18, 1.08 - torsoY, 0.018));
    torso.push(part(box(0.14, 0.035, 0.17), PALETTE.rust, -0.19, 1.56 - torsoY, 0, [1, 1, 1], -0.10));
    if (role === 'trader' || role === 'scout') torso.push(part(cylinder(0.017, 0.022, 1.30),
      PALETTE.leather, 0.26, 1.16 - torsoY, -0.15, [1, 1, 1], -0.1));
  }
  const rigid = [{ name: 'FactionTorso', y: torsoY, x: 0, parts: torso }];
  for (const [side, name] of [[-1, 'Left'], [1, 'Right']]) {
    const leg = [
      part(cylinder(0.075, 0.045, 0.90), PALETTE.dark, 0, -0.45, 0, [1, 1, 0.95]),
      part(box(0.102, 0.11, 0.19), PALETTE.leather, 0, -0.958, 0.027),
    ];
    const arm = [
      part(cylinder(0.052, 0.036, 0.60), PALETTE.cloth, 0, -0.30, 0),
      part(cylinder(0.035, 0.028, 0.11), PALETTE.skin, 0, -0.635, 0),
    ];
    if (!low) {
      leg.push(part(cylinder(0.056, 0.052, 0.21), PALETTE.wrap, 0, -0.72, 0));
      arm.push(part(cylinder(0.041, 0.038, 0.16), PALETTE.wrap, 0, -0.49, 0));
    }
    rigid.push({ name: `${name}LegPivot`, x: side * 0.098, y: 1.015, parts: leg });
    rigid.push({ name: `${name}ArmPivot`, x: side * 0.218, y: 1.535, parts: arm });
  }
  const root = new THREE.Group();
  // Prevent the old chunky coat/headgear from being added after cloning.
  root.name = 'MoyoAgentSilhouette';
  root.userData.moyoWastelandAgent = true;
  if (low) {
    const all = rigid.flatMap(piece => piece.parts.map(([geometry, color]) =>
      [geometry.translate(piece.x, piece.y, 0), color]));
    root.add(new THREE.Mesh(bake(all), bodyMaterial));
  } else {
    for (const piece of rigid) {
      const pivot = new THREE.Group(); pivot.name = piece.name;
      pivot.position.set(piece.x, piece.y, 0);
      pivot.add(new THREE.Mesh(bake(piece.parts), bodyMaterial));
      root.add(pivot);
    }
  }
  root.traverse(object => { if (object.isMesh) { object.castShadow = !low; object.receiveShadow = true; } });
  return root;
}

export function createWanderer(factionColor = '#879077', role = 'scout', detail = 'high') {
  role = ROLES.includes(role) ? role : 'scout';
  detail = ['high', 'mid', 'low'].includes(detail) ? detail : 'high';
  const key = `${role}:${detail}`;
  if (!templates.has(key)) templates.set(key, buildTemplate(role, detail));
  const root = templates.get(key).clone(true);
  const color = new THREE.Color(factionColor).lerp(new THREE.Color(PALETTE.wrap), 0.25);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.94, envMapIntensity: 0.2 });
  material.userData.moyoDecayStyled = true;
  const band = new THREE.Mesh(bandGeometry, material);
  band.name = 'MoyoFactionBand';
  const arm = root.getObjectByName('LeftArmPivot');
  band.position.set(arm ? 0 : -0.218, arm ? -0.15 : 1.385, 0.045);
  (arm || root).add(band);
  return root;
}

export function styleWastelandAsset(root, category) {
  if (!root) return root;
  // Retain authored silhouettes/UVs, but remove the saturated toy-plastic finish.
  const natural = /tree|rock/.test(category);
  root.traverse(object => {
    if (!object.isMesh || !object.material) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material.isMeshStandardMaterial || material.userData.moyoWastelandStyled) continue;
      material.userData.moyoWastelandStyled = true;
      material.userData.moyoDecayStyled = true;
      const hsl = {}; material.color.getHSL(hsl);
      material.color.setHSL(hsl.h, hsl.s * 0.50, hsl.l * 0.92);
      material.color.lerp(new THREE.Color(natural ? 0x93866a : 0x9b8161), 0.12);
      material.roughness = Math.max(material.roughness, natural ? 0.93 : 0.86);
      material.metalness = Math.min(material.metalness, 0.28);
      material.envMapIntensity = Math.min(material.envMapIntensity, 0.38);
    }
  });
  return root;
}
