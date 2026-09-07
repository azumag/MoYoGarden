import * as THREE from 'three';
import { isHexGridCell, hexTileWorldXZ } from './hex-grid.js';
import { hash2 } from './shared.js';
import { createSurfaceSampler } from './surface-detail.js';

export function groundCoverBudget(quality = {}) {
  if (quality.label === 'SAFE' || ['safe','low'].includes(quality.requested)) return 0;
  const budget = { balanced: 600, high: 1800, ultra: 2800 }[quality.id] ?? 600;
  return Math.floor(budget * Math.min(1, Math.max(0, quality.detailDensity ?? 1)));
}

function bladeGeometry() {
  const p=[], colors=[];
  for(let blade=0;blade<4;blade++) {
    const angle=blade*Math.PI*0.62;
    const dx=Math.cos(angle), dz=Math.sin(angle), h=0.2+blade*0.032;
    const points=[[-0.035,0],[0.035,0],[0.012,h*0.6],[-0.014,h*0.6],[0.055,h]];
    const vertices=points.map(([w,y])=>[dx*w,y,dz*w]);
    for(const i of [0,1,2,0,2,3,3,2,4]) {
      p.push(...vertices[i]);
      const light=0.55+points[i][1]/h*0.45;
      colors.push(light,light,light*0.91);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();
  return geometry;
}

function grassMaterial(clock) {
  const material=new THREE.MeshStandardMaterial({
    color:0xc2b180, vertexColors:true, side:THREE.DoubleSide,
    roughness:0.94, metalness:0, envMapIntensity:0.24,
  });
  material.userData.moyoDecayStyled=true;
  material.customProgramCacheKey=()=> 'moyo-grass-wind-v1';
  material.onBeforeCompile=shader=>{
    shader.uniforms.moyoTime=clock;
    shader.vertexShader='uniform float moyoTime;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        float phase = dot(instanceMatrix[3].xz, vec2(0.74,0.46));
        float bend = sin(moyoTime*1.1+phase)*0.035 + sin(moyoTime*0.63+phase*1.8)*0.015;
        transformed.x += bend * pow(clamp(position.y/0.3,0.0,1.0), 2.0);
      #endif
    `);
  };
  return material;
}

function contactShadows(state, sample) {
  const p=[],colors=[],indices=[];
  const entries=state.tiles.filter(t=>isHexGridCell(t,state.width,state.height)
    && t.terrain!=='water' && t.resource?.amount>0 && ['wood','stone'].includes(t.resource.kind))
    .map(t=>({position:t, radius:t.resource.kind==='wood'?0.48:0.29}));
  entries.push(...state.structures.map(s=>({position:s.position,radius:s.type==='market'?0.95:0.8})));
  for(const entry of entries.slice(0,400)) {
    const center=hexTileWorldXZ(entry.position,state.width,state.height);
    const y=sample(center.x,center.z);
    if (y===undefined || y < -0.1) continue;
    // Ground-conforming soft contact, not a flat circle that cuts through slopes.
    for(let j=0;j<12;j++) {
      const a=j*Math.PI/6, b=(j+1)*Math.PI/6;
      const rim=[a,b].map(t=>({x:center.x+Math.cos(t)*entry.radius,z:center.z+Math.sin(t)*entry.radius}));
      const heights=rim.map(v=>sample(v.x,v.z));
      if (heights.some(h=>h===undefined || h < -0.1)) continue;
      const base=p.length/3;
      p.push(center.x,y+0.012,center.z, rim[1].x,heights[1]+0.012,rim[1].z, rim[0].x,heights[0]+0.012,rim[0].z);
      colors.push(0.016,0.02,0.011,0.46, 0.016,0.02,0.011,0, 0.016,0.02,0.011,0);
      indices.push(base,base+1,base+2);
    }
  }
  if (!p.length) return null;
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const material=new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,depthWrite:false,
    polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  material.userData.moyoDecayStyled=true;
  const mesh=new THREE.Mesh(geometry,material);
  mesh.name='MoyoContactShadows';
  mesh.renderOrder=1;
  return mesh;
}

export function buildGroundCover(view, clock) {
  const group=new THREE.Group();
  group.name='MoyoGroundCover';
  const budget=groundCoverBudget(view.quality);
  if (!budget || !view.terrainMesh || !view.state) return group;
  const state=view.state, sample=createSurfaceSampler(view.terrainMesh.geometry);
  const candidates=[];
  for(const tile of state.tiles) {
    if (!isHexGridCell(tile,state.width,state.height) || tile.terrain==='water') continue;
    if (state.structures.some(s=>Math.hypot(s.position.x-tile.x,s.position.y-tile.y)<1.65)) continue;
    const center=hexTileWorldXZ(tile,state.width,state.height);
    const density=tile.terrain==='hill'?3:tile.terrain==='forest'?6:10;
    for(let j=0;j<density;j++) {
      const salt=2200+j*9;
      const x=center.x+(hash2(tile.x,tile.y,salt)-0.5)*0.82;
      const z=center.z+(hash2(tile.x,tile.y,salt+1)-0.5)*0.82;
      const y=sample(x,z);
      if (y===undefined || y< -0.08) continue;
      candidates.push({x,y,z,rank:hash2(tile.x,tile.y,salt+2),angle:hash2(tile.x,tile.y,salt+3)*Math.PI*2,
        scale:0.65+hash2(tile.x,tile.y,salt+4)*0.85});
    }
  }
  // Ranking before truncation avoids a dense strip on only one side of the map.
  candidates.sort((a,b)=>a.rank-b.rank);
  const entries=candidates.slice(0,budget);
  if(entries.length) {
    const mesh=new THREE.InstancedMesh(bladeGeometry(),grassMaterial(clock),entries.length);
    mesh.name='MoyoDryGrass';
    const matrix=new THREE.Matrix4(), q=new THREE.Quaternion(), up=new THREE.Vector3(0,1,0);
    const position=new THREE.Vector3(), scale=new THREE.Vector3(), color=new THREE.Color();
    entries.forEach((e,i)=>{
      position.set(e.x,e.y+0.004,e.z);q.setFromAxisAngle(up,e.angle);scale.set(e.scale,e.scale,e.scale);
      matrix.compose(position,q,scale);mesh.setMatrixAt(i,matrix);
      color.setHSL(0.17+e.rank*0.04,0.16+e.rank*0.13,0.29+e.rank*0.16);mesh.setColorAt(i,color);
    });
    mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;
    mesh.computeBoundingSphere();mesh.boundingSphere.radius+=0.12;
    mesh.receiveShadow=true;mesh.castShadow=false;
    group.add(mesh);
  }
  const shadow=contactShadows(state,sample);
  if(shadow)group.add(shadow);
  return group;
}

export function disposeGroundCover(group) {
  group?.traverse(object=>{
    if(object.isInstancedMesh)object.dispose();
    object.geometry?.dispose();
    object.material?.dispose();
  });
  group?.removeFromParent();
}

export function groundCoverSignature(view) {
  const state=view.state;
  return `${view.terrainMesh?.uuid}:${view.terrainMesh?.geometry?.uuid}:${view.terrainMesh?.geometry?.getAttribute('position')?.version}:${state?.tiles?.map(t=>`${t.terrain}:${t.resource?.amount>0?t.resource.kind:''}`).join(',')}:${state?.structures?.map(s=>`${s.type}:${s.position.x}:${s.position.y}`).join(',')}`;
}
