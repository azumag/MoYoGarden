import * as THREE from 'three';
import { hexGridDistance, isHexGridCell, hexTileWorldXZ } from './hex-grid.js';
import { hash2 } from './shared.js';
import { createSurfaceSampler, NOISE_GLSL } from './surface-detail.js';

const CONTACT_SHADOW_BUDGET = 400;

export function groundCoverBudget(quality = {}) {
  if (quality.label === 'SAFE' || ['safe','low'].includes(quality.requested)) return 0;
  const budget = { balanced: 600, high: 1800, ultra: 2800 }[quality.id] ?? 600;
  return Math.floor(budget * Math.min(1, Math.max(0, quality.detailDensity ?? 1)));
}

export function groundCoverBlockedByStructure(tile, structures = []) {
  return structures.some(structure => hexGridDistance(structure.position, tile) <= 1);
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

function grassMaterial(clock, atmosphere = {}) {
  const material=new THREE.MeshStandardMaterial({
    color:0xc2b180, vertexColors:true, side:THREE.DoubleSide,
    roughness:0.94, metalness:0, envMapIntensity:0.24,
  });
  material.userData.moyoDecayStyled=true;
  material.customProgramCacheKey=()=> 'moyo-grass-wind-v2';
  material.onBeforeCompile=shader=>{
    shader.uniforms.moyoTime=clock;
    shader.uniforms.moyoWorldOrigin=atmosphere.worldOrigin??{value:new THREE.Vector2()};
    shader.uniforms.moyoSunDirection=atmosphere.sunDirection??{value:new THREE.Vector3(-20,29,11).normalize()};
    shader.vertexShader='uniform float moyoTime;\nuniform vec2 moyoWorldOrigin;\n'+NOISE_GLSL+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        // Wind lives in the same absolute frame as the ground and water, even
        // after region recentering or under a translated parent group.
        mat4 moyoGrassWorld = modelMatrix * instanceMatrix;
        vec2 moyoGrassP = moyoGrassWorld[3].xz + moyoWorldOrigin;
        float phase = dot(moyoGrassP, vec2(0.74,0.46));
        float gust = moyoNoise(moyoGrassP*0.18-vec2(moyoTime*0.10,moyoTime*0.04));
        float bend = sin(moyoTime*1.25+phase)*0.036
          + sin(moyoTime*0.63+phase*0.46)*0.018 + gust*gust*0.058;
        vec3 moyoWind = vec3(0.92,0.0,0.38) * bend;
        // Project a common world-space wind into each rotated/scaled clump.
        vec3 moyoLocalWind = vec3(
          dot(moyoGrassWorld[0].xyz,moyoWind)/max(dot(moyoGrassWorld[0].xyz,moyoGrassWorld[0].xyz),0.0001),
          dot(moyoGrassWorld[1].xyz,moyoWind)/max(dot(moyoGrassWorld[1].xyz,moyoGrassWorld[1].xyz),0.0001),
          dot(moyoGrassWorld[2].xyz,moyoWind)/max(dot(moyoGrassWorld[2].xyz,moyoGrassWorld[2].xyz),0.0001));
        transformed += moyoLocalWind * pow(clamp(position.y/0.3,0.0,1.0),2.0);
      #endif
    `);
    shader.fragmentShader='uniform vec3 moyoSunDirection;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>', `
      // Thin dry blades transmit a little warm light when viewed toward the sun.
      float moyoBacklight = pow(max(dot(normalize(vViewPosition),mat3(viewMatrix)*moyoSunDirection),0.0),4.0);
      outgoingLight += diffuseColor.rgb * vec3(1.0,0.88,0.59) * moyoBacklight * 0.26;
      #include <opaque_fragment>
    `);
  };
  return material;
}

export function contactShadowEntries(state, limit = CONTACT_SHADOW_BUDGET) {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : CONTACT_SHADOW_BUDGET;
  if (safeLimit === 0) return [];

  // Buildings need contact shadows most: without them authored structures appear to
  // float above the terrain. Reserve budget for structures before sampling natural
  // props, then rank props deterministically so a saturated resource field does not
  // spend the remaining budget on one storage-order strip of the hex.
  const structures = state.structures.map(s=>({
    position:s.position,
    radius:s.type==='market'?0.95:0.8,
  }));
  if (structures.length >= safeLimit) return structures.slice(0,safeLimit);

  const resources=state.tiles.filter(t=>isHexGridCell(t,state.width,state.height)
    && t.terrain!=='water' && t.resource?.amount>0 && ['wood','stone'].includes(t.resource.kind))
    .map(t=>({
      position:t,
      radius:t.resource.kind==='wood'?0.48:0.29,
      rank:hash2(t.x,t.y,9173),
    }))
    .sort((a,b)=>a.rank-b.rank || a.position.y-b.position.y || a.position.x-b.position.x);
  const remaining = safeLimit - structures.length;
  return [
    ...structures,
    ...resources.slice(0,remaining).map(({position,radius})=>({position,radius})),
  ];
}

function contactShadows(state, sample) {
  const p=[],colors=[],indices=[];
  const entries=contactShadowEntries(state);
  for(const entry of entries) {
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
    if (groundCoverBlockedByStructure(tile,state.structures)) continue;
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
    const mesh=new THREE.InstancedMesh(bladeGeometry(),grassMaterial(clock,view.moyoAtmosphere),entries.length);
    mesh.name='MoyoDryGrass';
    const matrix=new THREE.Matrix4(), q=new THREE.Quaternion(), up=new THREE.Vector3(0,1,0);
    const position=new THREE.Vector3(), scale=new THREE.Vector3(), color=new THREE.Color();
    entries.forEach((e,i)=>{
      position.set(e.x,e.y+0.004,e.z);q.setFromAxisAngle(up,e.angle);scale.set(e.scale,e.scale,e.scale);
      matrix.compose(position,q,scale);mesh.setMatrixAt(i,matrix);
      color.setHSL(0.17+e.rank*0.04,0.16+e.rank*0.13,0.29+e.rank*0.16);mesh.setColorAt(i,color);
    });
    mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;
    mesh.computeBoundingSphere();mesh.boundingSphere.radius+=0.16;
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
  return `${groundCoverBudget(view.quality)}:${view.terrainMesh?.uuid}:${view.terrainMesh?.geometry?.uuid}:${view.terrainMesh?.geometry?.getAttribute('position')?.version}:${state?.tiles?.map(t=>`${t.terrain}:${t.resource?.amount>0?t.resource.kind:''}`).join(',')}:${state?.structures?.map(s=>`${s.type}:${s.position.x}:${s.position.y}`).join(',')}`;
}
