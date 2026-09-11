// Run after npm run build. Uses an installed Playwright via PLAYWRIGHT_MODULE
// (or `playwright`), and local seeded API fixtures. Never mutates production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createInitialWorld } from '../dist-ts/src/world.js';
import { simulate } from '../dist-ts/src/simulation.js';
import { regionHexWindow } from '../dist-ts/src/region-topology.js';
import { enrichRegionWindowPayload } from '../dist-ts/src/worker-entry.js';

const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const quality=process.argv[2] || 'high';
const baseline=process.env.MOYO_VISUAL_BASELINE==='1';
const out=resolve(process.env.MOYO_VISUAL_OUTPUT || `${tmpdir()}/moyo-visual-${baseline?'before':'after'}-${quality}`);
await mkdir(out,{recursive:true});
const regions=Array.from({length:19},(_,i)=>`garden-${i+1}`);
const states=new Map(regions.map((regionId,i)=>{
  let state=createInitialWorld({worldId:'visual-evidence',regionId,seed:424242+i*997,width:40,height:24});
  for(let tick=0;tick<(i===0?100:24);tick++)state=simulate(state).state;
  return [regionId,state];
}));
const root=resolve('public');
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.glb':'model/gltf-binary','.png':'image/png'};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    let body=await readFile(path);
    if(url.pathname==='/')body=body.toString().replace(/<script src="\/boot\.js\?[^\"]+"><\/script>/,`<script type="module">
      import {WorldView} from '/client/world-view.js';
      const previous=WorldView.prototype.setState;
      WorldView.prototype.setState=function(...args){window.__view=this;return previous.apply(this,args)};
      window.addEventListener('moyo:pbr-ready',()=>window.__ready=true);
      await import('/boot.js?visual-smoke=1');
    </script>`);
    if(baseline && url.pathname==='/boot.js')body=body.toString().replace(/    try \{\n      await import\(`\/client\/atmosphere\.js[\s\S]*?\n    \}\n/,'');
    res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream'});res.end(body);
  } catch {res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
const errors=[];
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),args:['--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/api/**',route=>{
    const u=new URL(route.request().url()),region=u.searchParams.get('region')||'garden-1';
    let value={};
    if(u.pathname.endsWith('/meta'))value={regions,defaultRegion:region,tickMs:10000,world:{regionExtent:{width:40,height:24},regionTopology:{kind:'hex-axial',regions:regionHexWindow(regions,region,Number(u.searchParams.get('radius')||1))}}};
    else if(u.pathname.endsWith('/snapshot'))value=states.get(region);
    else if(u.pathname.endsWith('/health'))value={paused:true,tickMs:10000};
    else if(u.pathname.endsWith('/window')){
      const radius=Number(u.searchParams.get('radius')||1);
      const chunks=regionHexWindow(regions,region,radius).map(t=>({regionId:t.id,origin:t.physicalOrigin,state:states.get(t.id)}));
      value=enrichRegionWindowPayload({centerRegion:region,radius,chunks},regions);
    }
    return route.fulfill({json:value});
  });
  await page.routeWebSocket('**/api/stream*',socket=>{
    const id=new URL(socket.url()).searchParams.get('region')||'garden-1';
    socket.send(JSON.stringify({state:states.get(id),paused:true,tickMs:10000}));
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?quality=${quality}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__ready===true,null,{timeout:20000});
  await page.waitForFunction(()=>document.querySelector('#render-status').textContent.includes('GLB 22/22'),null,{timeout:30000});
  await page.waitForTimeout(1500);
  await page.evaluate(()=>{const v=window.__view;v.cameraState.distance=22;v.cameraState.pitch=.49;v.cameraState.yaw=-.65;v.cameraState.target.set(-1,.22,0);});
  await page.waitForTimeout(900);
  await page.screenshot({path:resolve(out,'scene.png')});
  const stats=await page.evaluate(()=>{const v=window.__view;return {
    status:document.querySelector('#render-status').textContent,calls:v.renderer.info.render.calls,
    triangles:v.renderer.info.render.triangles,geometries:v.renderer.info.memory.geometries,
    textures:v.renderer.info.memory.textures,programs:v.renderer.info.programs.length,
    atmosphere:v.moyoAtmosphere?.stats??null,
    neighborLand:(()=>{const meshes=[];v.worldRoot.getObjectByName('neighbor-region-preview')?.traverse(o=>{if(o.name==='neighbor-hex-land')meshes.push({styled:o.material.userData.moyoSurfaceKind==='land',vertices:o.geometry.getAttribute('position').count});});return meshes;})(),
    renderer:v.renderer.getContext().getParameter(v.renderer.getContext().RENDERER)
  };});
  assert.equal(stats.neighborLand.length,18,'all outer terrain regions must be rendered');
  assert.ok(stats.neighborLand.every(m=>m.vertices>0),'neighbor terrain cannot be empty');
  if(!baseline){assert.ok(stats.neighborLand.every(m=>m.styled),'neighbor surfaces must share the material treatment');assert.ok(stats.atmosphere);assert.equal(stats.atmosphere.extraDraws,quality==='low'?0:2);}
  await page.evaluate(()=>{const v=window.__view;v.cameraState.distance=40;v.cameraState.pitch=.38;});
  await page.waitForTimeout(700);await page.screenshot({path:resolve(out,'overview.png')});
  // Exercise resource / region replacement repeatedly after shaders have compiled.
  for(const region of ['garden-2','garden-3','garden-1']) {
    await page.evaluate(state=>window.__view.setState(state,10000),states.get(region));
    await page.waitForTimeout(1000);
  }
  const coverRoots=await page.evaluate(()=>window.__view.worldRoot.children.filter(c=>c.name==='MoyoGroundCover').length);
  if(!baseline)assert.equal(coverRoots,1);
  await writeFile(resolve(out,'report.json'),JSON.stringify({quality,baseline,errors,stats,coverRoots},null,2));
  console.log(JSON.stringify({quality,baseline,errors,stats,coverRoots,output:out}));
  assert.deepEqual(errors,[],'browser or shader errors');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
