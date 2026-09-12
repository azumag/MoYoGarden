import assert from "node:assert/strict";
import test from "node:test";
import worker, { RegionDurableObject, regionLayout, regionTickDelayMs, regionVirtualCatchUpPlan, regionWindow } from "../dist-ts/src/worker.js";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { regionGlobalCellOrigin } from "../dist-ts/src/region-topology.js";
import { createGlobalTerrainTile } from "../dist-ts/src/world-scale.js";
class MemoryStorage {
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async getAlarm(){return this.alarm;}
  async setAlarm(value){this.alarm=value instanceof Date?value.getTime():value;}
  async deleteAlarm(){this.alarm=null;}
}
class MemoryState { constructor(storage=new MemoryStorage()){this.storage=storage;this.sockets=[];this.ready=Promise.resolve();} blockConcurrencyWhile(callback){this.ready=callback();return this.ready;} acceptWebSocket(socket){this.sockets.push(socket);} getWebSockets(){return [...this.sockets];} }
const env={WORLD_SEED:"424242",REGION_IDS:"garden-1,garden-test,garden-3",TICK_MS:"10000",OPEN_COMMANDS:"false",COMMAND_TOKEN:"command-secret",ADMIN_TOKEN:"admin-secret"};
function memoryNamespaceEnv(overrides={}){
  const scoped={...env,...overrides};
  const entries=new Map();
  scoped.REGIONS={
    idFromName:(name)=>name,
    get:(id)=>{
      let entry=entries.get(id);
      if(!entry){
        const state=new MemoryState(),object=new RegionDurableObject(state,scoped);
        entry={state,object};
        entries.set(id,entry);
      }
      return{fetch:async(req)=>{await entry.state.ready;return entry.object.fetch(req);}};
    },
  };
  return{env:scoped,entries};
}
function request(path,init={}){const headers=new Headers(init.headers);headers.set("x-moyo-region-internal","garden-test");return new Request(`https://moyo.example${path}`,{...init,headers});}

test("region tick cadence slows only while inactive",()=>{assert.equal(regionTickDelayMs(10000,false),60000);assert.equal(regionTickDelayMs(10000,true),10000);assert.equal(regionTickDelayMs(1000000,false),3600000);});

test("region layout gives adjacent chunks contiguous global coordinates",()=>{const layout=regionLayout(["garden-1","garden-2","garden-3"],40,24);assert.deepEqual(layout.map((entry)=>entry.origin),[{x:0,y:0},{x:40,y:0},{x:80,y:0}]);assert.equal(layout[0].origin.x+layout[0].extent.width,layout[1].origin.x);assert.equal(layout[1].origin.x+layout[1].extent.width,layout[2].origin.x);assert.deepEqual(layout.map((entry)=>entry.neighbors),[{west:null,east:"garden-2"},{west:"garden-1",east:"garden-3"},{west:"garden-2",east:null}]);});

test("region window follows logical hex distance instead of array index distance",()=>{const ids=Array.from({length:19},(_,index)=>`garden-${index+1}`);assert.deepEqual(regionWindow(ids,"garden-1",1,40,24).map((entry)=>entry.id),["garden-1","garden-2","garden-3","garden-4","garden-5","garden-6","garden-7"]);assert.deepEqual(regionWindow(ids,"garden-3",1,40,24).map((entry)=>entry.id),["garden-1","garden-2","garden-3","garden-4","garden-9","garden-11","garden-12"]);assert.deepEqual(regionWindow(ids,"garden-3",0,40,24).map((entry)=>entry.id),["garden-3"]);assert.deepEqual(regionWindow(ids,"garden-4",0,40,24).map((entry)=>entry.id),["garden-4"]);assert.deepEqual(regionWindow(ids,"garden-1",2,40,24).map((entry)=>entry.id),ids);assert.deepEqual(regionWindow(ids,"missing",1,40,24),[]);});

test("canonical sparse region window follows encoded axial coordinates instead of list order",()=>{const center="hex-q10-r-4",far="hex-q100-r100";const neighbors=["hex-q11-r-4","hex-q10-r-3","hex-q9-r-3","hex-q9-r-4","hex-q10-r-5","hex-q11-r-5"];const ids=[center,far,...neighbors];assert.deepEqual(regionWindow(ids,center,1,40,24).map((entry)=>entry.id),[center,...neighbors]);assert.deepEqual(regionWindow(ids,center,0,40,24).map((entry)=>entry.id),[center]);});

test("scoped meta keeps region topology bounded to the requested axial window",async()=>{const center="hex-q10-r-4",far="hex-q100-r100";const neighbors=["hex-q11-r-4","hex-q10-r-3","hex-q9-r-3","hex-q9-r-4","hex-q10-r-5","hex-q11-r-5"];const ids=[center,far,...neighbors];const response=await worker.fetch(new Request(`https://moyo.example/api/meta?region=${center}&radius=1`),{REGION_IDS:ids.join(","),WORLD_SEED:"424242"});assert.equal(response.status,200);const payload=await response.json();const expected=[center,...neighbors].sort();assert.deepEqual([...payload.regions].sort(),expected);assert.deepEqual(payload.world.regionTopology.regions.map((entry)=>entry.id).sort(),expected);assert.deepEqual(payload.world.regionLayout.map((entry)=>entry.id).sort(),expected);});

test("unlisted canonical regions are publicly addressable without extending REGION_IDS",async()=>{const canonical="hex-q0-r1";const scoped=memoryNamespaceEnv({REGION_IDS:"garden-1,garden-2,garden-3"});const response=await worker.fetch(new Request(`https://moyo.example/api/world/snapshot?region=${canonical}`),scoped.env);assert.equal(response.status,200);const state=await response.json();assert.equal(state.regionId,canonical);assert.ok(scoped.entries.has(canonical));});

test("scoped sparse meta and window synthesize only the local axial neighborhood",async()=>{const center="hex-q0-r1";const scoped=memoryNamespaceEnv({REGION_IDS:"garden-1,garden-2,garden-3"});const metaResponse=await worker.fetch(new Request(`https://moyo.example/api/meta?region=${center}&radius=1`),scoped.env);assert.equal(metaResponse.status,200);const meta=await metaResponse.json();assert.equal(meta.regions.includes(center),true);assert.equal(meta.regions.length,7);assert.equal(meta.world.regionTopology.regions.length,7);assert.equal(meta.world.regionTopology.regions.every((entry)=>entry.axial&&entry.id),true);const windowResponse=await worker.fetch(new Request(`https://moyo.example/api/world/window?region=${center}&radius=1`),scoped.env);assert.equal(windowResponse.status,200);const window=await windowResponse.json();assert.equal(window.centerRegion,center);assert.equal(window.chunks.length,7);assert.equal(window.chunks.every((chunk)=>chunk.state?.regionId===chunk.regionId),true);assert.equal(scoped.entries.size,7,"radius-one browsing must fan out to exactly the bounded local window");});

test("new regions persist a hex-compatible terrain frame without activating storage corners",async()=>{const ctx=new MemoryState(),object=new RegionDurableObject(ctx,env);await ctx.ready;const state=await (await object.fetch(request("/api/world/snapshot"))).json();assert.equal(state.regionId,"garden-test");const north=state.tiles.find((tile)=>tile.x===19&&tile.y===0);assert.ok(north);assert.equal(state.tiles[0].terrain,"water");assert.equal(state.tiles[state.width-1].terrain,"water");assert.ok(state.agents.every((agent)=>agent.position.x>=0&&agent.position.y>=0&&agent.position.x<state.width&&agent.position.y<state.height));assert.equal(ctx.storage.values.get("region").terrainFrameVersion,1);});

test("fresh canonical region initialization does not enumerate REGION_IDS", async () => {
  const regionId = "hex-q12-r-7";
  const canonicalEnv = { ...env };
  Object.defineProperty(canonicalEnv, "REGION_IDS", {
    get() { throw new Error("canonical terrain must not enumerate REGION_IDS"); },
  });
  const ctx = new MemoryState();
  const object = new RegionDurableObject(ctx, canonicalEnv);
  await ctx.ready;
  const headers = new Headers({ "x-moyo-region-internal": regionId });
  const response = await object.fetch(new Request("https://moyo.example/api/world/snapshot", { headers }));
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.regionId, regionId);
  assert.ok(regionGlobalCellOrigin(regionId, state.width, state.height));
});

test("fresh canonical regions generate their full active terrain from the shared global cell frame",async()=>{
  const regionId="hex-q7-r-3";
  const canonicalEnv={...env,REGION_IDS:regionId};
  const ctx=new MemoryState(),object=new RegionDurableObject(ctx,canonicalEnv);
  await ctx.ready;
  const headers=new Headers({"x-moyo-region-internal":regionId});
  const state=await (await object.fetch(new Request("https://moyo.example/api/world/snapshot",{headers}))).json();
  const origin=regionGlobalCellOrigin(regionId,state.width,state.height);
  assert.ok(origin);
  const active=state.tiles.filter((tile)=>isHexGridCell(state,tile));
  assert.equal(active.length,397);
  for(const tile of active){
    const expected=createGlobalTerrainTile(tile.x,tile.y,424242,origin.x,origin.y);
    assert.equal(tile.terrain,expected.terrain,`terrain mismatch at ${tile.x},${tile.y}`);
    assert.equal(tile.elevation,expected.elevation,`elevation mismatch at ${tile.x},${tile.y}`);
    assert.deepEqual(tile.resource,expected.resource,`resource mismatch at ${tile.x},${tile.y}`);
  }
});

test("passive snapshot prefetch keeps an unloaded region on idle cadence",async()=>{const ctx=new MemoryState(),object=new RegionDurableObject(ctx,env);await ctx.ready;const before=Date.now();const response=await object.fetch(request("/api/world/snapshot",{headers:{"x-moyo-prefetch":"1"}}));const state=await response.json();assert.equal(state.regionId,"garden-test");const health=await (await object.fetch(request("/api/health"))).json();assert.equal(health.tickMode,"idle");assert.equal(health.effectiveTickMs,60000);assert.ok(ctx.storage.alarm>=before+59000);assert.ok(ctx.storage.alarm<=before+61000);});

test("monitoring stays idle while world access promotes the region to active cadence",async()=>{const ctx=new MemoryState(),object=new RegionDurableObject(ctx,env);await ctx.ready;assert.equal(ctx.storage.alarm,null);const idleBefore=Date.now();const health=await (await object.fetch(request("/api/health"))).json();assert.equal(health.tickMode,"idle");assert.equal(health.effectiveTickMs,60000);assert.ok(ctx.storage.alarm>=idleBefore+59000);const activeBefore=Date.now();const response=await object.fetch(request("/api/world/snapshot"));const state=await response.json();assert.equal(state.regionId,"garden-test");assert.equal(state.agents.length,12);assert.ok(ctx.storage.alarm>=activeBefore+9000);assert.ok(ctx.storage.alarm<=activeBefore+11000);assert.equal(ctx.storage.values.get("region").state.regionId,"garden-test");const activeHealth=await (await object.fetch(request("/api/health"))).json();assert.equal(activeHealth.tickMode,"active");assert.equal(activeHealth.effectiveTickMs,10000);});

test("command and admin tokens are separated",async()=>{const ctx=new MemoryState(),object=new RegionDurableObject(ctx,env);await ctx.ready;const snapshot=await (await object.fetch(request("/api/world/snapshot"))).json();const agentId=snapshot.agents[0].id;const body=JSON.stringify({id:"worker-goal",type:"set_goal",goal:"Map the western water"});
  assert.equal((await object.fetch(request(`/api/agents/${agentId}/commands`,{method:"POST",headers:{"content-type":"application/json"},body}))).status,401);
  assert.equal((await object.fetch(request(`/api/agents/${agentId}/commands`,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer command-secret"},body}))).status,202);
  assert.equal((await object.fetch(request("/api/admin/tick",{method:"POST",headers:{"content-type":"application/json"},body:'{"count":1}'}))).status,401);
  const advanced=await object.fetch(request("/api/admin/tick",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer admin-secret"},body:'{"count":1}'}));
  const state=(await advanced.json()).state;assert.equal(state.tick,1);assert.equal(state.agents.find((entry)=>entry.id===agentId).goal,"Map the western water");
});

test("queued command survives object eviction",async()=>{const storage=new MemoryStorage(),firstCtx=new MemoryState(storage),first=new RegionDurableObject(firstCtx,env);await firstCtx.ready;const snapshot=await (await first.fetch(request("/api/world/snapshot"))).json();const agentId=snapshot.agents[0].id;
  const accepted=await first.fetch(request(`/api/agents/${agentId}/commands`,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer command-secret"},body:JSON.stringify({id:"hibernate-goal",type:"set_goal",goal:"Survive eviction"})}));assert.equal(accepted.status,202);
  const secondCtx=new MemoryState(storage),restored=new RegionDurableObject(secondCtx,env);await secondCtx.ready;await restored.alarm();const after=await (await restored.fetch(request("/api/world/snapshot"))).json();assert.equal(after.tick,1);assert.equal(after.agents.find((entry)=>entry.id===agentId).goal,"Survive eviction");
});
test("persisted simulation clock advances only when simulation advances", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const ctx = new MemoryState();
    const object = new RegionDurableObject(ctx, env);
    await ctx.ready;
    const snapshot = await (await object.fetch(request("/api/world/snapshot"))).json();
    const assignedAt = ctx.storage.values.get("region").lastSimulatedAt;
    assert.equal(assignedAt, now);

    now += 5_000;
    const command = await object.fetch(request(`/api/agents/${snapshot.agents[0].id}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer command-secret",
      },
      body: JSON.stringify({ id: "clock-goal", type: "set_goal", goal: "Track simulation time" }),
    }));
    assert.equal(command.status, 202);
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, assignedAt);

    now += 5_000;
    await object.alarm();
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, now);

    now += 30_000;
    const manualTick = await object.fetch(request("/api/admin/tick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({ count: 3 }),
    }));
    assert.equal(manualTick.status, 200);
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, now);
    const health = await (await object.fetch(request("/api/health"))).json();
    assert.equal(health.virtualTicksDue, 0);
    assert.equal(health.virtualTicksRunnable, 0);
  } finally {
    Date.now = originalNow;
  }
});


test("virtual catch-up planning is bounded and ignores paused wall time", () => {
  assert.deepEqual(
    regionVirtualCatchUpPlan(1_000, 11_000, 1_000, false, 3),
    { dueTicks: 10, runnableTicks: 3, capped: true },
  );
  assert.deepEqual(
    regionVirtualCatchUpPlan(1_000, 11_000, 1_000, true, 3),
    { dueTicks: 0, runnableTicks: 0, capped: false },
  );
  assert.deepEqual(
    regionVirtualCatchUpPlan(11_000, 11_000, 1_000, false, 3),
    { dueTicks: 0, runnableTicks: 0, capped: false },
  );
  assert.deepEqual(
    regionVirtualCatchUpPlan(0, 3_600_000, 10_000),
    { dueTicks: 360, runnableTicks: 12, capped: true },
  );
});

test("resume rebases virtual time so paused duration cannot become catch-up debt", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_100_000;
  Date.now = () => now;
  try {
    const ctx = new MemoryState();
    const object = new RegionDurableObject(ctx, env);
    await ctx.ready;
    await object.fetch(request("/api/world/snapshot"));

    now += 10_000;
    const paused = await object.fetch(request("/api/admin/pause", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }));
    assert.equal(paused.status, 200);

    now += 3_600_000;
    const pausedHealth = await (await object.fetch(request("/api/health"))).json();
    assert.equal(pausedHealth.virtualTicksDue, 0);
    assert.equal(pausedHealth.virtualTicksRunnable, 0);

    const resumed = await object.fetch(request("/api/admin/resume", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }));
    assert.equal(resumed.status, 200);
    assert.equal(ctx.storage.values.get("region").lastSimulatedAt, now);

    const resumedHealth = await (await object.fetch(request("/api/health"))).json();
    assert.equal(resumedHealth.virtualTicksDue, 0);
    assert.equal(resumedHealth.virtualTicksRunnable, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("live radius-one window promotes neighboring regions to active cadence", async () => {
  const scoped = memoryNamespaceEnv({ REGION_IDS: "garden-1,garden-2,garden-3" });
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=1&live=1"),
    scoped.env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.chunks.length, 7);
  for (const chunk of payload.chunks) {
    if (chunk.regionId === "garden-1") continue;
    const entry = scoped.entries.get(chunk.regionId);
    assert.ok(entry, `missing region object for ${chunk.regionId}`);
    const headers = new Headers({ "x-moyo-region-internal": chunk.regionId });
    const health = await (await entry.object.fetch(
      new Request("https://moyo.example/api/health", { headers }),
    )).json();
    assert.equal(health.tickMode, "active", `${chunk.regionId} must be active while visible`);
    assert.equal(health.effectiveTickMs, 10_000);
  }
});


test("terrain-only radius-two window stays passive and omits simulation objects", async () => {
  const scoped = memoryNamespaceEnv({ REGION_IDS: "garden-1,garden-2,garden-3" });
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=2&terrain=1"),
    scoped.env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.chunks.length, 19);
  for (const chunk of payload.chunks) {
    assert.ok(Array.isArray(chunk.state?.tiles));
    assert.equal("agents" in chunk.state, false);
    assert.equal("structures" in chunk.state, false);
    for (const tile of chunk.state.tiles) {
      assert.equal("resource" in tile, false);
    }
    if (chunk.regionId === "garden-1") continue;
    const entry = scoped.entries.get(chunk.regionId);
    const headers = new Headers({ "x-moyo-region-internal": chunk.regionId });
    const health = await (await entry.object.fetch(new Request("https://moyo.example/api/health", { headers }))).json();
    assert.equal(health.tickMode, "idle");
    assert.equal(health.effectiveTickMs, 60_000);
  }
});
