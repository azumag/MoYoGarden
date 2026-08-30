import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "public/models");
const TAU = Math.PI * 2;
await mkdir(OUT, { recursive: true });

function quat(rx = 0, ry = 0, rz = 0) {
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function box() {
  const p = [], n = [], i = [];
  const faces = [
    [[0, 0, 1], [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]]],
    [[0, 0,-1], [[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5]]],
    [[-1,0,0], [[-0.5,-0.5,-0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5]]],
    [[1,0,0], [[0.5,-0.5,0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5]]],
    [[0,1,0], [[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5]]],
    [[0,-1,0], [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[-0.5,-0.5,0.5]]],
  ];
  for (const [normal, vertices] of faces) {
    const base = p.length / 3;
    for (const vertex of vertices) { p.push(...vertex); n.push(...normal); }
    i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { p, n, i };
}

function cylinder(segments = 12, top = 0.5, bottom = 0.5) {
  const p = [], n = [], i = [];
  const slope = bottom - top;
  for (let index = 0; index < segments; index += 1) {
    const a0 = index / segments * TAU;
    const a1 = (index + 1) / segments * TAU;
    const x0 = Math.cos(a0), z0 = Math.sin(a0), x1 = Math.cos(a1), z1 = Math.sin(a1);
    const base = p.length / 3;
    p.push(x0 * bottom,-0.5,z0 * bottom, x1 * bottom,-0.5,z1 * bottom, x1 * top,0.5,z1 * top, x0 * top,0.5,z0 * top);
    for (const [x, z] of [[x0,z0],[x1,z1],[x1,z1],[x0,z0]]) {
      const length = Math.hypot(x, z, slope);
      n.push(x / length, slope / length, z / length);
    }
    i.push(base,base+1,base+2, base,base+2,base+3);
  }
  for (const [y, radius, normal, reverse] of [[-0.5,bottom,[0,-1,0],true],[0.5,top,[0,1,0],false]]) {
    if (radius <= 0) continue;
    const center = p.length / 3;
    p.push(0,y,0); n.push(...normal);
    const ring = [];
    for (let index = 0; index < segments; index += 1) {
      const angle = index / segments * TAU;
      ring.push(p.length / 3);
      p.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius); n.push(...normal);
    }
    for (let index = 0; index < segments; index += 1) {
      if (reverse) i.push(center, ring[(index + 1) % segments], ring[index]);
      else i.push(center, ring[index], ring[(index + 1) % segments]);
    }
  }
  return { p, n, i };
}

function sphere(latitude = 7, longitude = 10) {
  const p = [], n = [], i = [];
  for (let y = 0; y <= latitude; y += 1) {
    const phi = y / latitude * Math.PI;
    for (let x = 0; x <= longitude; x += 1) {
      const theta = x / longitude * TAU;
      const nx = Math.sin(phi) * Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(theta);
      p.push(nx * 0.5, ny * 0.5, nz * 0.5); n.push(nx, ny, nz);
    }
  }
  for (let y = 0; y < latitude; y += 1) {
    for (let x = 0; x < longitude; x += 1) {
      const a = y * (longitude + 1) + x, b = a + longitude + 1;
      i.push(a,b,a+1, b,b+1,a+1);
    }
  }
  return { p, n, i };
}

function gable() {
  const p = [], n = [], i = [];
  const vertices = [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0,0.5,-0.5],[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0,0.5,0.5]];
  const faces = [
    [[0,1,2],[0,0,-1]], [[5,4,3],[0,0,1]], [[0,3,4,1],[0,-1,0]],
    [[1,4,5,2],[0.707,0.707,0]], [[2,5,3,0],[-0.707,0.707,0]],
  ];
  for (const [ids, normal] of faces) {
    const base = p.length / 3;
    for (const id of ids) { p.push(...vertices[id]); n.push(...normal); }
    if (ids.length === 3) i.push(base,base+1,base+2);
    else i.push(base,base+1,base+2, base,base+2,base+3);
  }
  return { p, n, i };
}

function encodeValues(values, componentType) {
  const size = componentType === 5126 || componentType === 5125 ? 4 : 2;
  const buffer = Buffer.alloc(values.length * size);
  values.forEach((value, index) => {
    const offset = index * size;
    if (componentType === 5126) buffer.writeFloatLE(value, offset);
    else if (componentType === 5125) buffer.writeUInt32LE(value, offset);
    else buffer.writeUInt16LE(value, offset);
  });
  return buffer;
}

class GLB {
  constructor() {
    this.binary = Buffer.alloc(0); this.views = []; this.accessors = [];
    this.materials = []; this.meshes = []; this.nodes = [];
  }
  align() {
    const padding = (4 - this.binary.length % 4) % 4;
    if (padding) this.binary = Buffer.concat([this.binary, Buffer.alloc(padding)]);
  }
  material(name, color, metalness = 0, roughness = 0.8, emissive = null) {
    const material = {
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [color[0], color[1], color[2], 1],
        metallicFactor: metalness,
        roughnessFactor: roughness,
      },
    };
    if (emissive) material.emissiveFactor = [...emissive];
    this.materials.push(material); return this.materials.length - 1;
  }
  accessor(values, componentType, kind, target, min = null, max = null) {
    this.align();
    const offset = this.binary.length;
    const raw = encodeValues(values, componentType);
    this.binary = Buffer.concat([this.binary, raw]);
    this.views.push({ buffer: 0, byteOffset: offset, byteLength: raw.length, target });
    const width = kind === "VEC3" ? 3 : 1;
    const accessor = { bufferView: this.views.length - 1, componentType, count: values.length / width, type: kind };
    if (min) accessor.min = min; if (max) accessor.max = max;
    this.accessors.push(accessor); return this.accessors.length - 1;
  }
  mesh(name, geometry, material) {
    const triples = [];
    for (let index = 0; index < geometry.p.length; index += 3) triples.push(geometry.p.slice(index, index + 3));
    const min = [0,1,2].map((axis) => Math.min(...triples.map((value) => value[axis])));
    const max = [0,1,2].map((axis) => Math.max(...triples.map((value) => value[axis])));
    const position = this.accessor(geometry.p, 5126, "VEC3", 34962, min, max);
    const normal = this.accessor(geometry.n, 5126, "VEC3", 34962);
    const indexType = Math.max(...geometry.i) < 65535 ? 5123 : 5125;
    const indices = this.accessor(geometry.i, indexType, "SCALAR", 34963);
    this.meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material }] });
    return this.meshes.length - 1;
  }
  node(name, { mesh = null, position = null, scale = null, rotation = null, children = null, detail = false } = {}) {
    const node = { name };
    if (mesh !== null) node.mesh = mesh;
    if (position) node.translation = [...position];
    if (scale) node.scale = [...scale];
    if (rotation) node.rotation = [...rotation];
    if (children?.length) node.children = children;
    if (detail) node.extras = { moyoDetail: true };
    this.nodes.push(node); return this.nodes.length - 1;
  }
  async save(name, roots) {
    const document = {
      asset: { version: "2.0", generator: "MoYoGarden GLB generator" }, scene: 0,
      scenes: [{ nodes: roots }], nodes: this.nodes, meshes: this.meshes, materials: this.materials,
      buffers: [{ byteLength: this.binary.length }], bufferViews: this.views, accessors: this.accessors,
    };
    let json = Buffer.from(JSON.stringify(document));
    json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
    const binary = Buffer.concat([this.binary, Buffer.alloc((4 - this.binary.length % 4) % 4)]);
    const total = 12 + 8 + json.length + 8 + binary.length;
    const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67,0); header.writeUInt32LE(2,4); header.writeUInt32LE(total,8);
    const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(json.length,0); jsonHeader.writeUInt32LE(0x4e4f534a,4);
    const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length,0); binaryHeader.writeUInt32LE(0x004e4942,4);
    const output = Buffer.concat([header,jsonHeader,json,binaryHeader,binary]);
    await writeFile(resolve(OUT, name), output);
    return output.length;
  }
}

function part(glb, name, mesh, position, scale, rotation = null, detail = false) {
  return glb.node(name, { mesh, position, scale, rotation, detail });
}

async function makeSettler() {
  const g = new GLB();
  const cloth=g.material("FactionCloth",[0.42,0.5,0.56],0,0.78), dark=g.material("FactionClothDark",[0.18,0.22,0.25],0,0.9);
  const skin=g.material("Skin",[0.75,0.56,0.4],0,0.92), leather=g.material("Leather",[0.2,0.105,0.04],0,0.8);
  const metal=g.material("Metal",[0.44,0.47,0.48],0.78,0.26), wood=g.material("Wood",[0.3,0.15,0.05],0,0.82);
  const glow=g.material("Lamp",[0.9,0.72,0.22],0.05,0.3,[1,0.45,0.06]);
  const cube=g.mesh("Cube",box(),cloth), cubeDark=g.mesh("CubeDark",box(),dark), cubeLeather=g.mesh("CubeLeather",box(),leather);
  const cubeMetal=g.mesh("CubeMetal",box(),metal), limb=g.mesh("Limb",cylinder(10),cloth), ball=g.mesh("Ball",sphere(),skin);
  const woodCylinder=g.mesh("WoodCyl",cylinder(9),wood), lamp=g.mesh("LampMesh",sphere(5,7),glow);
  const children=[];
  for (const [side,label] of [[-1,"Left"],[1,"Right"]]) {
    const leg=part(g,`${label}LegMesh`,limb,[0,-0.22,0],[0.12,0.44,0.12]);
    const boot=part(g,`detail_${label}Boot`,cubeLeather,[0,-0.48,0.05],[0.17,0.14,0.25],null,true);
    children.push(g.node(`${label}LegPivot`,{position:[side*0.12,0.54,0],children:[leg,boot]}));
    const arm=part(g,`${label}ArmMesh`,limb,[0,-0.22,0],[0.1,0.44,0.1]);
    const hand=part(g,`${label}Hand`,ball,[0,-0.47,0],[0.15,0.15,0.15]);
    children.push(g.node(`${label}ArmPivot`,{position:[side*0.34,1.25,0],children:[arm,hand]}));
  }
  children.push(
    part(g,"FactionTorso",cube,[0,1.05,0],[0.48,0.58,0.3]),
    part(g,"detail_Belt",cubeLeather,[0,0.82,0],[0.5,0.09,0.33],null,true),
    part(g,"detail_Chest",cubeMetal,[0,1.08,0.17],[0.25,0.28,0.035],null,true),
    part(g,"Head",ball,[0,1.67,0],[0.36,0.42,0.34]),
    part(g,"detail_Hair",ball,[0,1.82,-0.01],[0.37,0.19,0.35],null,true),
    part(g,"detail_Backpack",cubeLeather,[0,1.1,-0.24],[0.38,0.47,0.22],null,true),
    part(g,"Role_builder_Handle",woodCylinder,[0.43,0.92,0.16],[0.035,0.46,0.035],quat(0,0,-0.45),true),
    part(g,"Role_builder_Head",cubeMetal,[0.54,1.09,0.16],[0.27,0.1,0.12],quat(0,0,-0.45),true),
    part(g,"Role_woodcutter_Handle",woodCylinder,[0.43,0.92,0.16],[0.035,0.58,0.035],quat(0,0,-0.38),true),
    part(g,"Role_woodcutter_Blade",cubeMetal,[0.55,1.15,0.16],[0.28,0.18,0.055],quat(0,0,-0.38),true),
    part(g,"Role_miner_Handle",woodCylinder,[0.43,0.92,0.16],[0.035,0.6,0.035],quat(0,0,-0.38),true),
    part(g,"Role_miner_Head",cubeMetal,[0.54,1.17,0.16],[0.42,0.055,0.07],quat(0,0,-0.38),true),
    part(g,"Role_miner_Lamp",lamp,[0,1.87,0.18],[0.11,0.08,0.08],null,true),
    part(g,"Role_forager_Basket",cubeLeather,[0.4,0.78,0.06],[0.28,0.33,0.28],null,true),
  );
  return g.save("settler.glb",[g.node("SettlerRoot",{children})]);
}

async function makeTree() {
  const g=new GLB(); const bark=g.material("Bark",[0.2,0.09,0.025],0,0.96), leaves=g.material("Leaves",[0.07,0.27,0.08],0,0.9), light=g.material("LeavesLight",[0.16,0.42,0.12],0,0.86);
  const trunk=g.mesh("Trunk",cylinder(12,0.3,0.45),bark), branch=g.mesh("Branch",cylinder(8,0.2,0.25),bark), crown=g.mesh("Crown",sphere(8,12),leaves), crown2=g.mesh("Crown2",sphere(7,10),light);
  const children=[part(g,"Trunk",trunk,[0,0.72,0],[0.34,1.44,0.34])];
  [[-0.25,1.2,0,0.7],[0.27,1.36,0.08,-0.65],[0,1.48,-0.2,0.15]].forEach(([x,y,z,r],index)=>children.push(part(g,`detail_Branch${index}`,branch,[x,y,z],[0.12,0.65,0.12],quat(0,0,r),true)));
  [[0,1.82,0,1,crown],[-0.42,1.6,0.1,0.72,crown],[0.4,1.68,-0.08,0.75,crown2],[0,2.16,-0.12,0.65,crown2],[0.05,1.76,0.38,0.62,crown]].forEach(([x,y,z,s,mesh],index)=>children.push(part(g,`Foliage${index}`,mesh,[x,y,z],[s,0.72*s,s])));
  return g.save("tree.glb",[g.node("TreeRoot",{children})]);
}

async function makeRock() {
  const g=new GLB(); const stone=g.material("Stone",[0.43,0.44,0.41],0.03,0.96), ore=g.material("Ore",[0.3,0.36,0.4],0.62,0.28);
  const rock=g.mesh("Rock",sphere(4,7),stone), vein=g.mesh("Ore",sphere(4,6),ore), children=[];
  [[0,0.24,0,0.8,0.2],[-0.32,0.14,0.12,0.48,-0.5],[0.35,0.12,-0.08,0.42,0.7],[0.1,0.1,0.34,0.35,0.1]].forEach(([x,y,z,s,r],index)=>children.push(part(g,`Rock${index}`,rock,[x,y,z],[s,0.55*s,0.7*s],quat(0,r,0))));
  children.push(part(g,"detail_OreVein",vein,[0.08,0.34,0.16],[0.24,0.09,0.3],quat(0.3,0.4,0.2),true));
  return g.save("rock.glb",[g.node("RockRoot",{children})]);
}

async function makeBuildings() {
  const g=new GLB();
  const wood=g.material("Wood",[0.34,0.17,0.055],0,0.86), wood2=g.material("WoodLight",[0.52,0.31,0.12],0,0.82), stone=g.material("Stone",[0.42,0.42,0.38],0.02,0.96);
  const cloth=g.material("FactionCloth",[0.54,0.25,0.14],0,0.82), metal=g.material("Metal",[0.36,0.39,0.4],0.74,0.3), dark=g.material("Dark",[0.08,0.055,0.035],0,0.93);
  const glass=g.material("Glass",[0.28,0.52,0.62],0.08,0.18), fire=g.material("Fire",[1,0.32,0.035],0,0.2,[1,0.24,0.01]);
  const mesh={
    wood:g.mesh("Wood",box(),wood), wood2:g.mesh("Wood2",box(),wood2), stone:g.mesh("Stone",box(),stone), cloth:g.mesh("ClothGable",gable(),cloth),
    metalRoof:g.mesh("MetalGable",gable(),metal), pole:g.mesh("Pole",cylinder(8),wood), chimney:g.mesh("Chimney",cylinder(10),stone), dark:g.mesh("Dark",box(),dark),
    glass:g.mesh("Glass",box(),glass), fire:g.mesh("Fire",cylinder(8,0,0.5),fire), roundStone:g.mesh("RoundStone",sphere(4,7),stone),
  };
  const roots=[];
  let children=[part(g,"FactionTent",mesh.cloth,[-0.1,0.55,0],[1.25,1.05,1.05]),part(g,"FlagPole",mesh.pole,[-0.72,0.85,-0.42],[0.035,1.7,0.035]),part(g,"FactionFlag",mesh.wood2,[-0.5,1.45,-0.42],[0.42,0.26,0.035],null,true)];
  for(let index=0;index<8;index+=1){const angle=index/8*TAU;children.push(part(g,"detail_FireStone",mesh.roundStone,[0.62+Math.cos(angle)*0.22,0.06,0.18+Math.sin(angle)*0.22],[0.18,0.1,0.16],null,true));}
  children.push(part(g,"detail_Fire",mesh.fire,[0.62,0.28,0.18],[0.18,0.38,0.18],null,true)); roots.push(g.node("Camp",{children}));

  children=[part(g,"Walls",mesh.wood2,[0,0.62,0],[1.3,1.1,1.05]),part(g,"FactionRoof",mesh.cloth,[0,1.42,0],[1.5,0.58,1.28]),part(g,"Door",mesh.dark,[0,0.48,0.53],[0.38,0.82,0.045])];
  for(const x of [-0.62,0.62])for(const z of [-0.49,0.49])children.push(part(g,"detail_Beam",mesh.wood,[x,0.7,z],[0.09,1.35,0.09],null,true));
  children.push(part(g,"detail_Window",mesh.glass,[0.42,0.78,0.535],[0.28,0.3,0.025],null,true),part(g,"detail_Crate",mesh.wood,[0.8,0.18,0.25],[0.38,0.36,0.38],null,true)); roots.push(g.node("Storehouse",{children}));

  children=[part(g,"Platform",mesh.wood,[0,0.08,0],[1.5,0.16,1.2]),part(g,"Counter",mesh.wood,[0,0.47,0.34],[1.18,0.38,0.28]),part(g,"FactionCanopy",mesh.cloth,[0,1.38,0],[1.6,0.48,1.25])];
  for(const x of [-0.65,0.65])for(const z of [-0.48,0.48])children.push(part(g,"Pole",mesh.pole,[x,0.78,z],[0.04,1.4,0.04]));
  children.push(part(g,"detail_Crate",mesh.wood2,[-0.45,0.23,-0.24],[0.42,0.4,0.4],null,true),part(g,"detail_Crate",mesh.wood2,[0.46,0.23,-0.2],[0.42,0.4,0.4],null,true)); roots.push(g.node("Market",{children}));

  children=[part(g,"Walls",mesh.stone,[0,0.66,0],[1.35,1.2,1.1]),part(g,"FactionRoof",mesh.metalRoof,[0,1.52,0],[1.5,0.55,1.3]),part(g,"Door",mesh.dark,[-0.2,0.5,0.56],[0.4,0.88,0.05]),part(g,"Chimney",mesh.chimney,[0.45,1.65,-0.24],[0.16,1,0.16]),part(g,"detail_Window",mesh.glass,[0.36,0.82,0.565],[0.28,0.32,0.025],null,true),part(g,"detail_Workbench",mesh.wood,[0.76,0.36,0.15],[0.62,0.16,0.35],null,true),part(g,"detail_Anvil",mesh.stone,[0.78,0.58,0.15],[0.34,0.16,0.18],null,true)];
  roots.push(g.node("Workshop",{children}));
  return g.save("buildings.glb",[g.node("BuildingsRoot",{children:roots})]);
}

const generated = await Promise.all([
  ["settler.glb", makeSettler()], ["tree.glb", makeTree()], ["rock.glb", makeRock()], ["buildings.glb", makeBuildings()],
].map(async ([name, work]) => [name, await work]));
for (const [name, size] of generated) console.log(`${name}: ${size} bytes`);
