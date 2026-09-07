// Optional local verification: npm install --no-save --package-lock=false playwright
// Run: node tools/render-graphics-smoke.mjs before (or after)
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const label = process.argv[2] || 'after';
const root = resolve('public');
const out = resolve('graphics-evidence');
await mkdir(out, { recursive: true });
const patches = ['sky-fix','hex-footprint-rendering','seamless-navigation','hex-neighbor-preview','hex-tile-rendering','hex-terrain-stitching','agent-crowding','decay-dressing'];
if (label !== 'before') patches.push('world-atmosphere');
const html = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
<script type="importmap">{"imports":{"three":"/vendor/three-r185/build/three.module.min.js","three/addons/":"/vendor/three-r185/examples/jsm/"}}</script></head>
<body><canvas id="world"></canvas><script type="module">
${patches.map(name => `await import('/client/${name}.js');`).join('\n')}
const { WorldView } = await import('/client/world-view.js');
const { ModelLibrary } = await import('/client/model-library.js');
const { createDemoState } = await import('/client/demo-state.js');
const { resolveQualityProfile } = await import('/client/quality.js');
const models = new ModelLibrary();
const quality = resolveQualityProfile();
const view = new WorldView(document.querySelector('canvas'), models, quality);
window.view = view;
const state = createDemoState();
view.setState(state);
view.cameraState.distance = 19;
view.cameraState.pitch = 0.46;
view.cameraState.target.set(-1, 0.15, 0);
view.startEnhancements();
await models.load({ timeoutMs: 12000, concurrency: 2, onModelLoaded: ({key}) => view.refreshModelType(key) });
await view.initializeEnvironment();
await new Promise(resolve => setTimeout(resolve, 1200));
window.ready = true;
</script></body></html>`;
const types = {'.js':'text/javascript','.html':'text/html','.json':'application/json','.glb':'model/gltf-binary'};
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__graphics') { res.setHeader('content-type','text/html'); res.end(html); return; }
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    if (!path.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(path);
    res.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  const modes = (label === 'before' || process.argv.includes('--high-only')) ? ['high'] : ['high','balanced','low','reduced'];
  for (const mode of modes) {
    const page = await browser.newPage({ viewport: {width:1440, height:900}, deviceScaleFactor:1, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const started = Date.now();
    await page.goto(`http://127.0.0.1:${server.address().port}/__graphics?quality=${mode === 'reduced' ? 'high' : mode}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 45000 });
    const metrics = await page.evaluate(async () => {
      const v = window.view;
      const gl = v.renderer.getContext();
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const frames = [];
      let last = performance.now();
      for (let i=0; i<90; i++) await new Promise(resolve => requestAnimationFrame(time => { frames.push(time-last); last=time; resolve(); }));
      frames.sort((a,b) => a-b);
      v.renderer.setAnimationLoop(null);
      v.frame(8000);
      return { gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), quality: v.quality.label, draws:v.renderer.info.render.calls, triangles:v.renderer.info.render.triangles, geometries:v.renderer.info.memory.geometries, textures:v.renderer.info.memory.textures, frameMedianMs:frames[45], frameP95Ms:frames[85], models:v.models.lastLoadResult, surfacePrograms:v.renderer.info.programs.length };
    });
    await page.screenshot({ path: resolve(out, `${label}-${mode}.jpg`), type:'jpeg', quality:88 });
    const rebuilt = await page.evaluate(() => {
      const v = window.view;
      for (let i = 0; i < 4; i++) { v.buildTerrain(v.state); v.markShadowsDirty(); v.frame(8000); }
      return { geometries: v.renderer.info.memory.geometries, textures: v.renderer.info.memory.textures };
    });
    if (rebuilt.geometries > metrics.geometries || rebuilt.textures > metrics.textures) errors.push("terrain replacement grew GPU resource counts");
    results.push({mode, elapsedMs:Date.now()-started, ...metrics, rebuilt, errors});
    console.log(JSON.stringify(results.at(-1)));
    await page.close();
  }
  await writeFile(resolve(out, `${label}.json`), JSON.stringify(results, null, 2));
  if (results.some(result => result.errors.length || result.models.failed.length)) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
