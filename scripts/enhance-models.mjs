import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const MODEL_DIR = resolve(ROOT, "public/models");
const SIZE = 64;
const TAU = Math.PI * 2;
const FILES = ["settler.glb", "tree.glb", "rock.glb", "buildings.glb"];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function fract(value) {
  return value - Math.floor(value);
}

function noise(x, y, seed) {
  return fract(Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453);
}

function profileFor(name = "") {
  const value = name.toLowerCase();
  if (value.includes("glass") || value.includes("fire") || value.includes("lamp")) return "skip";
  if (value.includes("bark") || value === "wood" || value.includes("woodlight")) return "wood";
  if (value.includes("leather") || value.includes("dark")) return "leather";
  if (value.includes("leaf") || value.includes("foliage")) return "leaf";
  if (value.includes("stone") || value.includes("rock")) return "stone";
  if (value.includes("metal") || value.includes("ore")) return "metal";
  if (value.includes("skin")) return "skin";
  if (value.includes("cloth") || value.includes("faction")) return "cloth";
  return "generic";
}

function surfaceSignal(profile, x, y, seed) {
  const u = x / SIZE;
  const v = y / SIZE;
  const n0 = noise(x, y, seed);
  const n1 = noise(Math.floor(x / 3), Math.floor(y / 3), seed + 11);
  if (profile === "wood") {
    const grain = Math.sin((u * 18 + n1 * 1.8) * TAU) * 0.5 + 0.5;
    return 0.42 + grain * 0.32 + n0 * 0.18;
  }
  if (profile === "leather") return 0.56 + n0 * 0.2 + Math.sin((u + v) * 28) * 0.04;
  if (profile === "leaf") return 0.55 + n1 * 0.3 + Math.sin((u * 7 + v * 5) * TAU) * 0.06;
  if (profile === "stone") return 0.42 + n1 * 0.34 + n0 * 0.14;
  if (profile === "metal") return 0.62 + n0 * 0.12 + (y % 13 === 0 ? 0.16 : 0);
  if (profile === "cloth") {
    const weave = (Math.sin(u * TAU * 24) + Math.sin(v * TAU * 24)) * 0.055;
    return 0.68 + weave + n0 * 0.08;
  }
  if (profile === "skin") return 0.72 + n1 * 0.05 + n0 * 0.025;
  return 0.62 + n0 * 0.16;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function makeTextureSet(material, seed) {
  const profile = profileFor(material.name);
  if (profile === "skip") return null;
  const pbr = material.pbrMetallicRoughness || {};
  const original = pbr.baseColorFactor || [0.65, 0.65, 0.65, 1];
  const base = material.name?.toLowerCase().includes("faction")
    ? [0.74, 0.74, 0.74]
    : original.slice(0, 3);
  const roughness = pbr.roughnessFactor ?? 0.8;
  const metallic = pbr.metallicFactor ?? 0;
  const color = Buffer.alloc(SIZE * SIZE * 4);
  const orm = Buffer.alloc(SIZE * SIZE * 4);
  const normal = Buffer.alloc(SIZE * SIZE * 4);
  const signal = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      signal[y * SIZE + x] = surfaceSignal(profile, x, y, seed);
    }
  }

  const strength = profile === "stone" ? 2.2
    : profile === "wood" ? 2.0
      : profile === "cloth" ? 1.25
        : profile === "leaf" ? 1.1
          : profile === "metal" ? 0.7 : 0.45;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const s = signal[y * SIZE + x];
      const variation = 0.72 + s * 0.48;
      color[offset] = clampByte(base[0] * variation);
      color[offset + 1] = clampByte(base[1] * variation);
      color[offset + 2] = clampByte(base[2] * variation);
      color[offset + 3] = clampByte(original[3] ?? 1);

      const roughVariation = Math.max(0.08, Math.min(1, roughness * (0.84 + (1 - s) * 0.24)));
      const metalVariation = Math.max(0, Math.min(1, metallic * (0.9 + s * 0.12)));
      orm[offset] = 255;
      orm[offset + 1] = clampByte(roughVariation);
      orm[offset + 2] = clampByte(metalVariation);
      orm[offset + 3] = 255;

      const left = signal[y * SIZE + ((x - 1 + SIZE) % SIZE)];
      const right = signal[y * SIZE + ((x + 1) % SIZE)];
      const up = signal[((y - 1 + SIZE) % SIZE) * SIZE + x];
      const down = signal[((y + 1) % SIZE) * SIZE + x];
      let nx = (left - right) * strength;
      let ny = (up - down) * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      normal[offset] = clampByte(nx * 0.5 + 0.5);
      normal[offset + 1] = clampByte(ny * 0.5 + 0.5);
      normal[offset + 2] = clampByte(nz * 0.5 + 0.5);
      normal[offset + 3] = 255;
    }
  }

  return {
    color: encodePng(SIZE, SIZE, color),
    orm: encodePng(SIZE, SIZE, orm),
    normal: encodePng(SIZE, SIZE, normal),
  };
}

function parseGlb(data) {
  if (data.toString("ascii", 0, 4) !== "glTF" || data.readUInt32LE(4) !== 2) {
    throw new Error("Expected glTF 2.0 GLB");
  }
  const jsonLength = data.readUInt32LE(12);
  if (data.toString("ascii", 16, 20) !== "JSON") throw new Error("GLB has no JSON chunk");
  const document = JSON.parse(data.toString("utf8", 20, 20 + jsonLength).trim());
  const binHeader = 20 + jsonLength;
  const binLength = data.readUInt32LE(binHeader);
  if (data.readUInt32LE(binHeader + 4) !== 0x004e4942) throw new Error("GLB has no BIN chunk");
  const binary = Buffer.from(data.subarray(binHeader + 8, binHeader + 8 + binLength));
  return { document, binary };
}

function aligned(buffer, alignment = 4) {
  const padding = (alignment - buffer.length % alignment) % alignment;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding)]) : buffer;
}

function appendBinary(state, data, target = undefined) {
  state.binary = aligned(state.binary, 4);
  const byteOffset = state.binary.length;
  state.binary = Buffer.concat([state.binary, data]);
  const view = { buffer: 0, byteOffset, byteLength: data.length };
  if (target !== undefined) view.target = target;
  state.document.bufferViews.push(view);
  return state.document.bufferViews.length - 1;
}

function readVec3Accessor(document, binary, accessorIndex) {
  const accessor = document.accessors[accessorIndex];
  const view = document.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.type !== "VEC3") {
    throw new Error("Expected FLOAT VEC3 accessor");
  }
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 12;
  const values = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const base = offset + index * stride;
    values.push([
      binary.readFloatLE(base),
      binary.readFloatLE(base + 4),
      binary.readFloatLE(base + 8),
    ]);
  }
  return values;
}

function attachUvs(state) {
  for (const mesh of state.document.meshes) {
    for (const primitive of mesh.primitives) {
      if (primitive.attributes.TEXCOORD_0 !== undefined) continue;
      const positions = readVec3Accessor(state.document, state.binary, primitive.attributes.POSITION);
      const min = [0, 1, 2].map((axis) => Math.min(...positions.map((value) => value[axis])));
      const max = [0, 1, 2].map((axis) => Math.max(...positions.map((value) => value[axis])));
      const dx = Math.max(0.001, max[0] - min[0]);
      const dy = Math.max(0.001, max[1] - min[1]);
      const dz = Math.max(0.001, max[2] - min[2]);
      const uv = Buffer.alloc(positions.length * 8);
      positions.forEach(([x, y, z], index) => {
        const ux = (x - min[0]) / dx;
        const uz = (z - min[2]) / dz;
        const u = (ux * 0.68 + uz * 0.32) % 1;
        const v = (y - min[1]) / dy;
        uv.writeFloatLE(u, index * 8);
        uv.writeFloatLE(v, index * 8 + 4);
      });
      const view = appendBinary(state, uv, 34962);
      state.document.accessors.push({
        bufferView: view,
        componentType: 5126,
        count: positions.length,
        type: "VEC2",
        min: [0, 0],
        max: [1, 1],
      });
      primitive.attributes.TEXCOORD_0 = state.document.accessors.length - 1;
    }
  }
}

function attachTextures(state, fileSeed) {
  state.document.samplers ||= [];
  state.document.images ||= [];
  state.document.textures ||= [];
  const sampler = state.document.samplers.length;
  state.document.samplers.push({
    magFilter: 9729,
    minFilter: 9987,
    wrapS: 10497,
    wrapT: 10497,
  });

  state.document.materials.forEach((material, materialIndex) => {
    const textures = makeTextureSet(material, fileSeed * 101 + materialIndex * 17 + 1);
    if (!textures) return;
    const addTexture = (buffer, suffix) => {
      const view = appendBinary(state, buffer);
      const image = state.document.images.length;
      state.document.images.push({
        name: `${material.name || `material_${materialIndex}`}_${suffix}`,
        bufferView: view,
        mimeType: "image/png",
      });
      const texture = state.document.textures.length;
      state.document.textures.push({ sampler, source: image });
      return texture;
    };
    const colorTexture = addTexture(textures.color, "baseColor");
    const ormTexture = addTexture(textures.orm, "metalRough");
    const normalTexture = addTexture(textures.normal, "normal");
    material.pbrMetallicRoughness ||= {};
    material.pbrMetallicRoughness.baseColorTexture = { index: colorTexture, texCoord: 0 };
    material.pbrMetallicRoughness.metallicRoughnessTexture = { index: ormTexture, texCoord: 0 };
    material.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, material.pbrMetallicRoughness.baseColorFactor?.[3] ?? 1];
    material.normalTexture = {
      index: normalTexture,
      texCoord: 0,
      scale: profileFor(material.name) === "stone" || profileFor(material.name) === "wood" ? 0.52 : 0.3,
    };
  });
}

function serializeGlb(state) {
  state.binary = aligned(state.binary, 4);
  state.document.buffers[0].byteLength = state.binary.length;
  let json = Buffer.from(JSON.stringify(state.document));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binary = aligned(state.binary, 4);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

for (let index = 0; index < FILES.length; index += 1) {
  const name = FILES[index];
  const path = resolve(MODEL_DIR, name);
  const input = await readFile(path);
  const state = parseGlb(input);
  attachUvs(state);
  attachTextures(state, index + 1);
  state.document.asset.generator = "MoYoGarden GLB generator + procedural PBR texture baker";
  const output = serializeGlb(state);
  await writeFile(path, output);
  console.log(`${name}: textured ${input.length} -> ${output.length} bytes`);
}
