import * as THREE from "three";
import { worldXZToHexTile } from "./hex-grid.js";
import { hash2 } from "./shared.js";

function tuftGeometry() {
  const positions = [], colors = [];
  const root = new THREE.Color(0x343c28), tip = new THREE.Color(0x92906b);
  for (let blade = 0; blade < 3; blade++) {
    const angle = blade * Math.PI * 2 / 3;
    const x = Math.cos(angle) * 0.04, z = Math.sin(angle) * 0.04;
    const height = 0.14 + blade * 0.04;
    positions.push(-x, 0, -z, x, 0, z, x * 0.65, height, z * 0.65 + 0.035);
    colors.push(root.r, root.g, root.b, root.r, root.g, root.b, tip.r, tip.g, tip.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Sample real triangles, so stitches/slopes cannot leave floating foliage. */
export function createGroundCover(terrainMesh, state, quality, uniforms) {
  if (!terrainMesh?.geometry || quality.label === "SAFE") return null;
  const capacity = quality.id === "ultra" ? 1400 : quality.id === "high" ? 1000 : 420;
  const budget = Math.floor(capacity * Math.min(1, quality.detailDensity ?? 0.6));
  const geometry = terrainMesh.geometry, position = geometry.attributes.position;
  const indices = geometry.index;
  const triangles = Math.floor((indices?.count ?? position.count) / 3);
  const occupied = new Set((state.structures ?? []).map(({ position: p }) => `${p.x}:${p.y}`));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const point = new THREE.Vector3(), entries = [];
  const seed = Number(state.seed) || 0;
  for (let attempt = 0; attempt < budget * 5 && entries.length < budget; attempt++) {
    const triangle = Math.min(triangles - 1, Math.floor(hash2(attempt, seed, 810) * triangles));
    if (triangle < 0) break;
    const vertex = (offset) => indices ? indices.getX(triangle * 3 + offset) : triangle * 3 + offset;
    a.fromBufferAttribute(position, vertex(0));
    b.fromBufferAttribute(position, vertex(1));
    c.fromBufferAttribute(position, vertex(2));
    if (Math.min(a.y, b.y, c.y) < -0.1) continue;
    const u = Math.sqrt(hash2(attempt, seed, 811));
    const v = hash2(attempt, seed, 812);
    point.copy(a).multiplyScalar(1 - u).addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v);
    const tile = worldXZToHexTile(point.x, point.z, state.width, state.height);
    if (!tile || occupied.has(`${tile.x}:${tile.y}`)) continue;
    const patch = hash2(Math.floor(point.x * 1.2), Math.floor(point.z * 1.2), 814);
    if (patch < 0.27) continue;
    entries.push({ x: point.x, y: point.y + 0.003, z: point.z, yaw: v * Math.PI * 2,
      scale: 0.55 + hash2(attempt, seed, 815) * 0.8, tint: patch });
  }
  if (!entries.length) return null;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1,
    metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.32 });
  material.userData.moyoDecayStyled = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMoyoTime = uniforms.time;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
      uniform float uMoyoTime;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float moyoPhase = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
        transformed.x += sin(uMoyoTime * 1.3 + moyoPhase) * position.y * position.y * 0.45;
        transformed.z += cos(uMoyoTime * 0.9 + moyoPhase) * position.y * position.y * 0.25;`);
  };
  material.customProgramCacheKey = () => "moyo-ground-cover-v1";
  const cover = new THREE.InstancedMesh(tuftGeometry(), material, entries.length);
  cover.name = "moyo-ground-cover";
  cover.castShadow = false;
  cover.receiveShadow = true;
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(), color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  entries.forEach((entry, index) => {
    point.set(entry.x, entry.y, entry.z);
    quaternion.setFromAxisAngle(up, entry.yaw);
    scale.setScalar(entry.scale);
    matrix.compose(point, quaternion, scale);
    cover.setMatrixAt(index, matrix);
    color.setRGB(0.78 + entry.tint * 0.2, 0.82 + entry.tint * 0.16, 0.72 + entry.tint * 0.2);
    cover.setColorAt(index, color);
  });
  cover.instanceMatrix.needsUpdate = true;
  cover.computeBoundingSphere();
  cover.boundingSphere.radius += 0.15;
  return cover;
}
