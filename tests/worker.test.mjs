import assert from "node:assert/strict";
import test from "node:test";
import { RegionDurableObject, regionLayout, regionTickDelayMs, regionWindow } from "../dist-ts/src/worker.js";
class MemoryStorage {
  constructor(){this.values=new Map();this.alarm=null;}
  async get(key){return structuredClone(this.values.get(key));}
  async put(key,value){this.values.set(key,structuredClone(value));}
  async getAlarm(){return this.alarm;}
  async setAlarm(value){this.alarm=value instanceof Date?value.getTime():value;}
  async deleteAlarm(){this.alarm=null;}
}
class MemoryState { constructor(storage=new MemoryStorage()){this.storage=storage;this.sockets=[];this.ready=Promise.resolve();} blockConcurrencyWhile(callback){this.ready=callback();return this.ready;} acceptWebSocket(socket){this.sockets.push(socket);} getWebSockets(){return [...this.sockets];} }
const env={WORLD_SEED:"424242",TICK_MS:"10000",OPEN_COMMANDS:"false",COMMAND_TOKEN:"command-secret",ADMIN_TOKEN:"admin-secret"};
function request(path,init={}){const headers=new Headers(init.headers);headers.set("x-moyo-region-internal","garden-test");return new Request(`https://moyo.example${path}`,{...init,headers});}

test("region tick cadence slows only while inactive",()=>{assert.equal(regionTickDelayMs(10000,false),60000);assert.equal(regionTickDelayMs(10000,true),10000);assert.equal(regionTickDelayMs(1000000,false),3600000);});

test("region layout gives adjacent chunks contiguous global coordinates",()=>{const layout=regionLayout(["garden-1","garden-2","garden-3"],40,24);assert.deepEqual(layout.map((entry)=>entry.origin),[{x:0,y:0},{x:40,y:0},{x:80,y:0}]);assert.equal(layout[0].origin.x+layout[0].extent.width,layout[1].origin.x);assert.equal(layout[1].origin.x+layout[1].extent.width,layout[2].origin.x);assert.deepEqual(layout.map((entry)=>entry.neighbors),[{west:null,east:"garden-2"},{west:"garden-1",east:"garden-3"},{west:"garden-2",east:null}]);});

test("region window returns only nearby chunks around the active region",()=>{const ids=["garden-1","garden-2","garden-3","garden-4","garden-5"];assert.deepEqual(regionWindow(ids,"garden-3",1,40,24).map((entry)=>entry.id),["garden-2","garden-3","garden-4"]);assert.deepEqual(regionWindow(ids,"garden-1",2,40,24).map((entry)=>entry.id),["garden-1","garden-2","garden-3"]);assert.deepEqual(regionWindow(ids,"missing",1,40,24),[]);});

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
