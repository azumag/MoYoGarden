const $ = (selector) => document.querySelector(selector);
const ui = {
  canvas: $("#world"), connectionDot: $("#connection-dot"), connectionLabel: $("#connection-label"),
  regionLabel: $("#region-label"), tickLabel: $("#tick-label"), agentCount: $("#agent-count"),
  structureCount: $("#structure-count"), pauseButton: $("#pause-button"), stepButton: $("#step-button"),
  resetButton: $("#reset-button"), focusButton: $("#focus-button"), settingsButton: $("#settings-button"),
  settingsPanel: $("#settings-panel"), settingsClose: $("#settings-close"), regionSelect: $("#region-select"),
  tokenInput: $("#token-input"), reconnectButton: $("#reconnect-button"), agentEmpty: $("#agent-empty"),
  agentDetail: $("#agent-detail"), agentSwatch: $("#agent-swatch"), agentName: $("#agent-name"),
  agentRole: $("#agent-role"), agentFaction: $("#agent-faction"), agentPosition: $("#agent-position"),
  agentHp: $("#agent-hp"), agentAutonomy: $("#agent-autonomy"), agentStatus: $("#agent-status"),
  invWood: $("#inv-wood"), invStone: $("#inv-stone"), invFood: $("#inv-food"), agentGoal: $("#agent-goal"),
  factionList: $("#faction-list"), eventList: $("#event-list"), pausedBadge: $("#paused-badge"),
  toast: $("#toast"), loading: $("#loading"),
};

const ROLE_LABELS = {
  builder: "建築家", woodcutter: "木こり", miner: "鉱夫", forager: "採集者", scout: "斥候", trader: "商人",
};
const TERRAIN_COLORS = {
  plain: [0.29, 0.47, 0.27], forest: [0.16, 0.34, 0.20], hill: [0.42, 0.37, 0.29], water: [0.10, 0.30, 0.39],
};
const STRUCTURE_COLORS = {
  camp: [0.72, 0.53, 0.31], storehouse: [0.54, 0.48, 0.36], market: [0.80, 0.64, 0.28], workshop: [0.49, 0.53, 0.51],
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function hexColor(value) {
  const clean = typeof value === "string" ? value.replace("#", "") : "c8ff66";
  const expanded = clean.length === 3 ? clean.split("").map((part) => part + part).join("") : clean;
  const number = Number.parseInt(expanded, 16);
  if (!Number.isFinite(number)) return [0.78, 1, 0.4];
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}
function mat4Perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function mat4LookAt(eye, center, up) {
  const z = normalize(subtract(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ]);
}
function mat4Model(position, scale, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([
    c * scale[0], 0, -s * scale[0], 0,
    0, scale[1], 0, 0,
    s * scale[2], 0, c * scale[2], 0,
    position[0], position[1], position[2], 1,
  ]);
}
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader allocation failed");
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
  return shader;
}
function createProgram(gl, vertex, fragment) {
  const program = gl.createProgram();
  if (!program) throw new Error("program allocation failed");
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "program link failed");
  return program;
}
function pushFace(positions, normals, colors, indices, corners, normal, color = [1, 1, 1]) {
  const base = positions.length / 3;
  for (const corner of corners) { positions.push(...corner); normals.push(...normal); colors.push(...color); }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function boxGeometry() {
  const positions = [], normals = [], colors = [], indices = [];
  pushFace(positions,normals,colors,indices,[[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]],[0,0,1]);
  pushFace(positions,normals,colors,indices,[[.5,-.5,-.5],[-.5,-.5,-.5],[-.5,.5,-.5],[.5,.5,-.5]],[0,0,-1]);
  pushFace(positions,normals,colors,indices,[[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5],[-.5,.5,-.5]],[-1,0,0]);
  pushFace(positions,normals,colors,indices,[[.5,-.5,.5],[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5]],[1,0,0]);
  pushFace(positions,normals,colors,indices,[[-.5,.5,.5],[.5,.5,.5],[.5,.5,-.5],[-.5,.5,-.5]],[0,1,0]);
  pushFace(positions,normals,colors,indices,[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]],[0,-1,0]);
  return { positions, normals, colors, indices };
}
function pyramidGeometry() {
  const positions = [], normals = [], colors = [], indices = [];
  pushFace(positions,normals,colors,indices,[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]],[0,-1,0]);
  const faces = [
    [[-.5,-.5,.5],[.5,-.5,.5],[0,.5,0]], [[.5,-.5,.5],[.5,-.5,-.5],[0,.5,0]],
    [[.5,-.5,-.5],[-.5,-.5,-.5],[0,.5,0]], [[-.5,-.5,-.5],[-.5,-.5,.5],[0,.5,0]],
  ];
  for (const face of faces) {
    const normal = normalize(cross(subtract(face[1], face[0]), subtract(face[2], face[0])));
    const base = positions.length / 3;
    for (const vertex of face) { positions.push(...vertex); normals.push(...normal); colors.push(1,1,1); }
    indices.push(base, base + 1, base + 2);
  }
  return { positions, normals, colors, indices };
}

class WebGLWorld {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!this.gl) throw new Error("WebGL 2に対応したブラウザが必要です");
    this.fov = Math.PI / 4.1;
    this.camera = { yaw: -0.74, pitch: 0.68, distance: 34, target: [0, 0.2, 0] };
    this.state = null; this.tickMs = 10_000; this.selectedAgentId = null; this.motion = new Map();
    this.terrainMesh = null; this.terrainKey = ""; this.drag = null;
    this.onSelect = () => {}; this.onCommand = () => {};

    this.program = createProgram(this.gl, `#version 300 es
      in vec3 a_position; in vec3 a_normal; in vec3 a_color;
      uniform mat4 u_projection; uniform mat4 u_view; uniform mat4 u_model; uniform vec3 u_tint;
      out vec3 v_color; out float v_light; out float v_depth;
      void main() {
        vec4 world = u_model * vec4(a_position, 1.0);
        vec3 normal = normalize(mat3(u_model) * a_normal);
        vec3 sun = normalize(vec3(-0.45, 0.88, 0.28));
        v_light = 0.36 + max(dot(normal, sun), 0.0) * 0.64;
        v_color = a_color * u_tint;
        vec4 viewPosition = u_view * world;
        v_depth = -viewPosition.z;
        gl_Position = u_projection * viewPosition;
      }`, `#version 300 es
      precision highp float; in vec3 v_color; in float v_light; in float v_depth;
      uniform float u_alpha; out vec4 outColor;
      void main() {
        vec3 fogColor = vec3(0.055, 0.105, 0.085);
        float fog = smoothstep(34.0, 72.0, v_depth);
        outColor = vec4(mix(v_color * v_light, fogColor, fog), u_alpha);
      }`);
    this.locations = {
      position: this.gl.getAttribLocation(this.program, "a_position"), normal: this.gl.getAttribLocation(this.program, "a_normal"),
      color: this.gl.getAttribLocation(this.program, "a_color"), projection: this.gl.getUniformLocation(this.program, "u_projection"),
      view: this.gl.getUniformLocation(this.program, "u_view"), model: this.gl.getUniformLocation(this.program, "u_model"),
      tint: this.gl.getUniformLocation(this.program, "u_tint"), alpha: this.gl.getUniformLocation(this.program, "u_alpha"),
    };
    this.meshes = { box: this.createMesh(boxGeometry()), pyramid: this.createMesh(pyramidGeometry()) };
    this.gl.enable(this.gl.DEPTH_TEST); this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.clearColor(0.055, 0.105, 0.085, 1);
    this.bindInput(); requestAnimationFrame((time) => this.frame(time));
  }
  createMesh(geometry) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const bind = (values, location) => {
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
    };
    bind(geometry.positions, this.locations.position); bind(geometry.normals, this.locations.normal); bind(geometry.colors, this.locations.color);
    const indexBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geometry.indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null); return { vao, count: geometry.indices.length };
  }
  tileAt(x, y) {
    if (!this.state || x < 0 || y < 0 || x >= this.state.width || y >= this.state.height) return null;
    return this.state.tiles[y * this.state.width + x] || null;
  }
  terrainHeight(tile) {
    if (!tile) return 0; if (tile.terrain === "hill") return 0.62; if (tile.terrain === "forest") return 0.14;
    if (tile.terrain === "water") return -0.2; return 0;
  }
  worldPosition(position, lift = 0) {
    const tile = this.tileAt(position.x, position.y);
    return [position.x - this.state.width / 2 + .5, this.terrainHeight(tile) + lift, position.y - this.state.height / 2 + .5];
  }
  buildTerrain(state) {
    const positions = [], normals = [], colors = [], indices = [];
    for (const tile of state.tiles) {
      const x = tile.x - state.width / 2, z = tile.y - state.height / 2, y = this.terrainHeight(tile);
      const color = TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain;
      pushFace(positions, normals, colors, indices,
        [[x,y,z],[x+1,y,z],[x+1,y,z+1],[x,y,z+1]], [0,1,0], color);
    }
    if (this.terrainMesh?.vao) this.gl.deleteVertexArray(this.terrainMesh.vao);
    this.terrainMesh = this.createMesh({ positions, normals, colors, indices });
  }
  setState(state, tickMs = this.tickMs) {
    const now = performance.now();
    if (this.state) {
      for (const agent of state.agents) {
        const previous = this.state.agents.find((entry) => entry.id === agent.id);
        const old = previous ? this.worldPosition(previous.position, .62) : null;
        this.motion.set(agent.id, { from: old || [0,0,0], to: null, start: now });
      }
    }
    this.state = state; this.tickMs = tickMs;
    const key = `${state.worldId}:${state.seed}:${state.width}:${state.height}`;
    if (key !== this.terrainKey) { this.terrainKey = key; this.buildTerrain(state); this.camera.distance = Math.max(state.width, state.height) * 1.12; }
    for (const agent of state.agents) {
      const target = this.worldPosition(agent.position, .62); const entry = this.motion.get(agent.id);
      if (entry) entry.to = target; else this.motion.set(agent.id, { from: target, to: target, start: now });
    }
  }
  agentPosition(agent, now) {
    const entry = this.motion.get(agent.id); if (!entry || !entry.to) return this.worldPosition(agent.position, .62);
    const t = clamp((now - entry.start) / Math.max(250, this.tickMs * .82), 0, 1);
    return [lerp(entry.from[0],entry.to[0],t), lerp(entry.from[1],entry.to[1],t), lerp(entry.from[2],entry.to[2],t)];
  }
  cameraVectors() {
    const cp = Math.cos(this.camera.pitch), sp = Math.sin(this.camera.pitch);
    const eye = [
      this.camera.target[0] + Math.sin(this.camera.yaw) * cp * this.camera.distance,
      this.camera.target[1] + sp * this.camera.distance,
      this.camera.target[2] + Math.cos(this.camera.yaw) * cp * this.camera.distance,
    ];
    const forward = normalize(subtract(this.camera.target, eye));
    const right = normalize(cross(forward, [0,1,0]));
    const up = normalize(cross(right, forward));
    return { eye, forward, right, up };
  }
  draw(mesh, position, scale, color, yaw = 0, alpha = 1) {
    const gl = this.gl; gl.bindVertexArray(mesh.vao);
    gl.uniformMatrix4fv(this.locations.model, false, mat4Model(position, scale, yaw));
    gl.uniform3fv(this.locations.tint, color); gl.uniform1f(this.locations.alpha, alpha);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  }
  frame(now) {
    this.resize(); const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.useProgram(this.program);
    const { eye } = this.cameraVectors();
    gl.uniformMatrix4fv(this.locations.projection, false, mat4Perspective(this.fov, this.canvas.width / this.canvas.height, .1, 140));
    gl.uniformMatrix4fv(this.locations.view, false, mat4LookAt(eye, this.camera.target, [0,1,0]));
    if (this.state && this.terrainMesh) {
      this.draw(this.meshes.box, [0,-.58,0], [this.state.width+.22,.72,this.state.height+.22], [.075,.13,.10]);
      this.draw(this.terrainMesh, [0,0,0], [1,1,1], [1,1,1]);
      for (const tile of this.state.tiles) this.drawResource(tile);
      for (const structure of this.state.structures) this.drawStructure(structure);
      for (const agent of this.state.agents) this.drawAgent(agent, now);
    }
    requestAnimationFrame((time) => this.frame(time));
  }
  drawResource(tile) {
    if (!tile.resource || tile.resource.amount <= 0 || tile.terrain === "water") return;
    const base = this.worldPosition(tile, .08);
    const density = clamp(tile.resource.amount / Math.max(1, tile.resource.maxAmount), .25, 1);
    if (tile.resource.kind === "wood") {
      this.draw(this.meshes.box, [base[0],base[1]+.35,base[2]], [.14,.7,.14], [.34,.22,.11]);
      this.draw(this.meshes.pyramid, [base[0],base[1]+1.05,base[2]], [.72,.95,.72], [.18,.52,.25], 0, .72+.28*density);
    } else if (tile.resource.kind === "stone") {
      this.draw(this.meshes.pyramid, [base[0],base[1]+.27,base[2]], [.65,.55,.7], [.56,.59,.57], tile.x*.37);
    } else {
      this.draw(this.meshes.box, [base[0]-.18,base[1]+.17,base[2]], [.19,.34,.19], [.73,.76,.20]);
      this.draw(this.meshes.box, [base[0]+.14,base[1]+.12,base[2]+.12], [.16,.24,.16], [.94,.56,.20]);
    }
  }
  drawStructure(structure) {
    const base = this.worldPosition(structure.position, 0);
    const faction = this.state.factions.find((entry) => entry.id === structure.factionId);
    const factionColor = hexColor(faction?.color); const typeColor = STRUCTURE_COLORS[structure.type] || [.55,.5,.4];
    const active = structure.status === "active";
    const progress = active ? 1 : clamp(structure.progress / Math.max(1, structure.requiredProgress), .12, 1);
    const height = (structure.type === "workshop" ? 1.3 : structure.type === "storehouse" ? 1.05 : .8) * progress;
    this.draw(this.meshes.box, [base[0],base[1]+height/2,base[2]], [.78,height,.78], typeColor, 0, active ? 1 : .55);
    this.draw(this.meshes.pyramid, [base[0],base[1]+height+.28,base[2]], [.92,.48,.92], factionColor, 0, active ? .94 : .45);
    if (structure.type === "market") this.draw(this.meshes.box, [base[0],base[1]+.28,base[2]+.52], [.88,.12,.18], factionColor);
  }
  drawAgent(agent, now) {
    const position = this.agentPosition(agent, now);
    const faction = this.state.factions.find((entry) => entry.id === agent.factionId);
    const color = hexColor(faction?.color);
    if (agent.id === this.selectedAgentId) {
      this.draw(this.meshes.box, [position[0],position[1]-.56,position[2]], [.8,.035,.8], [0.78,1,.4], 0, .72);
    }
    const taskTarget = agent.task?.target;
    const yaw = taskTarget ? Math.atan2(taskTarget.x-agent.position.x, taskTarget.y-agent.position.y) : 0;
    this.draw(this.meshes.box, position, [.36,.72,.32], color, yaw);
    this.draw(this.meshes.box, [position[0],position[1]+.55,position[2]], [.28,.28,.28], [0.84,.79,.66], yaw);
    const roleColor = agent.role === "builder" ? [1,.83,.28] : agent.role === "miner" ? [.68,.75,.82] : agent.role === "woodcutter" ? [.48,.79,.35] : [.86,.54,.25];
    this.draw(this.meshes.box, [position[0],position[1]+.09,position[2]-.19], [.18,.18,.08], roleColor, yaw);
  }
  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.7);
    const width = Math.floor(this.canvas.clientWidth * ratio), height = Math.floor(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.gl.viewport(0,0,width,height);
  }
  screenToTile(clientX, clientY) {
    if (!this.state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX-rect.left)/rect.width)*2-1, ny = 1-((clientY-rect.top)/rect.height)*2;
    const { eye, forward, right, up } = this.cameraVectors();
    const spread = Math.tan(this.fov/2), aspect = rect.width/rect.height;
    const direction = normalize([
      forward[0] + right[0]*nx*aspect*spread + up[0]*ny*spread,
      forward[1] + right[1]*nx*aspect*spread + up[1]*ny*spread,
      forward[2] + right[2]*nx*aspect*spread + up[2]*ny*spread,
    ]);
    if (Math.abs(direction[1]) < .0001) return null;
    const t = -eye[1]/direction[1]; if (t <= 0) return null;
    const x = eye[0]+direction[0]*t, z = eye[2]+direction[2]*t;
    const tile = { x: Math.floor(x+this.state.width/2), y: Math.floor(z+this.state.height/2) };
    return this.tileAt(tile.x,tile.y) ? tile : null;
  }
  bindInput() {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { x:event.clientX, y:event.clientY, lastX:event.clientX, lastY:event.clientY, moved:false, button:event.button };
      this.canvas.focus();
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || this.drag.button !== 0) return;
      const dx = event.clientX-this.drag.lastX, dy = event.clientY-this.drag.lastY;
      if (Math.hypot(event.clientX-this.drag.x,event.clientY-this.drag.y)>4) this.drag.moved=true;
      if (this.drag.moved) { this.camera.yaw -= dx*.008; this.camera.pitch=clamp(this.camera.pitch+dy*.006,.18,1.28); }
      this.drag.lastX=event.clientX; this.drag.lastY=event.clientY;
    });
    this.canvas.addEventListener("pointerup", (event) => {
      if (this.drag && !this.drag.moved && this.drag.button===0) {
        const tile=this.screenToTile(event.clientX,event.clientY);
        if (tile && this.state) {
          const agent=this.state.agents.find((entry)=>Math.hypot(entry.position.x-tile.x,entry.position.y-tile.y)<.8);
          this.selectedAgentId=agent?.id||null; this.onSelect(this.selectedAgentId);
        }
      }
      this.drag=null;
    });
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault(); const tile=this.screenToTile(event.clientX,event.clientY);
      if (tile && this.selectedAgentId) this.onCommand(this.selectedAgentId,tile);
    });
    this.canvas.addEventListener("wheel", (event) => { event.preventDefault(); this.camera.distance=clamp(this.camera.distance*Math.exp(event.deltaY*.001),8,72); }, {passive:false});
    window.addEventListener("keydown", (event) => {
      if (["INPUT","SELECT"].includes(document.activeElement?.tagName)) return;
      const amount=Math.max(1,this.camera.distance*.025); let dx=0,dz=0;
      if (event.key.toLowerCase()==="w") dz=-amount; if (event.key.toLowerCase()==="s") dz=amount;
      if (event.key.toLowerCase()==="a") dx=-amount; if (event.key.toLowerCase()==="d") dx=amount;
      if (dx||dz) {
        const c=Math.cos(this.camera.yaw),s=Math.sin(this.camera.yaw);
        this.camera.target[0]+=dx*c+dz*s; this.camera.target[2]+=-dx*s+dz*c;
      }
    });
  }
  focusAgent(agentId) {
    const agent=this.state?.agents.find((entry)=>entry.id===agentId); if (!agent) return;
    const position=this.worldPosition(agent.position,0); this.camera.target=[position[0],.2,position[2]]; this.camera.distance=Math.min(this.camera.distance,18);
  }
}

let renderer;
try { renderer = new WebGLWorld(ui.canvas); }
catch (error) { ui.loading.innerHTML = `<p>${String(error.message || error)}</p>`; throw error; }

const app = {
  state: null, paused: false, tickMs: 10_000, region: "garden-1", regions: ["garden-1"],
  token: sessionStorage.getItem("moyo-token") || "", socket: null, pollTimer: null, reconnectTimer: null,
};
ui.tokenInput.value = app.token;

let toastTimer;
function toast(message, error=false) {
  clearTimeout(toastTimer); ui.toast.textContent=message; ui.toast.className=`toast show${error?" error":""}`;
  toastTimer=setTimeout(()=>ui.toast.className="toast",2800);
}
function setConnection(mode, label) {
  ui.connectionDot.className=`connection-dot ${mode}`; ui.connectionLabel.textContent=label;
}
function authHeaders(jsonBody=false) {
  const headers={}; if (jsonBody) headers["content-type"]="application/json";
  if (app.token) headers.authorization=`Bearer ${app.token}`; return headers;
}
function apiUrl(path) {
  const url=new URL(path,location.origin); if (path!=="/api/meta") url.searchParams.set("region",app.region); return url;
}
async function requestJson(path, options={}) {
  const response=await fetch(apiUrl(path),options); const body=await response.json().catch(()=>({}));
  if (!response.ok) { const error=new Error(body.error||`HTTP ${response.status}`); error.status=response.status; throw error; }
  return body;
}
function applyEnvelope(value) {
  const state=value?.state || value; if (!state?.tiles || !state?.agents) return;
  app.state=state; app.paused=Boolean(value?.paused ?? app.paused); app.tickMs=Number(value?.tickMs)||app.tickMs;
  renderer.setState(state,app.tickMs); updateUi(); ui.loading.classList.add("hidden");
}
function updateUi() {
  const state=app.state; if (!state) return;
  ui.regionLabel.textContent=state.regionId; ui.tickLabel.textContent=String(state.tick);
  ui.agentCount.textContent=String(state.agents.length); ui.structureCount.textContent=String(state.structures.length);
  ui.pausedBadge.hidden=!app.paused; ui.pauseButton.textContent=app.paused?"再開":"一時停止";
  ui.factionList.replaceChildren();
  for (const faction of state.factions) {
    const card=document.createElement("div"); card.className="faction-card";
    const stripe=document.createElement("i"); stripe.style.background=faction.color;
    const info=document.createElement("div"); const name=document.createElement("strong"); name.textContent=faction.name;
    const count=document.createElement("small"); count.textContent=`BOT ${state.agents.filter((a)=>a.factionId===faction.id).length} / 建物 ${state.structures.filter((s)=>s.factionId===faction.id).length}`;
    info.append(name,count); const resources=document.createElement("code"); resources.textContent=`木${faction.resources.wood} 石${faction.resources.stone} 食${faction.resources.food}`;
    card.append(stripe,info,resources); ui.factionList.append(card);
  }
  ui.eventList.replaceChildren();
  for (const event of state.events.slice(-12).reverse()) {
    const item=document.createElement("li"), time=document.createElement("time"); time.textContent=`T${event.tick}`;
    item.append(time,document.createTextNode(event.message)); ui.eventList.append(item);
  }
  updateAgentDetail();
}
function updateAgentDetail() {
  const state=app.state, agent=state?.agents.find((entry)=>entry.id===renderer.selectedAgentId);
  if (!agent) { ui.agentEmpty.hidden=false; ui.agentDetail.hidden=true; return; }
  const faction=state.factions.find((entry)=>entry.id===agent.factionId);
  ui.agentEmpty.hidden=true; ui.agentDetail.hidden=false; ui.agentSwatch.style.background=faction?.color||"#c8ff66";
  ui.agentName.textContent=agent.name; ui.agentRole.textContent=ROLE_LABELS[agent.role]||agent.role;
  ui.agentFaction.textContent=faction?.name||agent.factionId; ui.agentPosition.textContent=`${agent.position.x}, ${agent.position.y}`;
  ui.agentHp.textContent=String(agent.hp); ui.agentAutonomy.textContent=agent.autonomy?"ON":"OFF"; ui.agentStatus.textContent=agent.status;
  ui.invWood.textContent=String(agent.inventory.wood); ui.invStone.textContent=String(agent.inventory.stone); ui.invFood.textContent=String(agent.inventory.food);
  ui.agentGoal.textContent=agent.goal || "目標未設定";
}
renderer.onSelect=()=>updateAgentDetail();
renderer.onCommand=async(agentId,target)=>{
  try {
    await requestJson(`/api/agents/${encodeURIComponent(agentId)}/commands`,{
      method:"POST",headers:authHeaders(true),body:JSON.stringify({id:`web-move-${crypto.randomUUID()}`,type:"move",target}),
    }); toast(`移動命令: ${target.x}, ${target.y}`);
  } catch(error) { if(error.status===401) ui.settingsPanel.hidden=false; toast(error.message,true); }
};
async function loadSnapshot() {
  const [state,health]=await Promise.all([requestJson("/api/world/snapshot"),requestJson("/api/health")]);
  applyEnvelope({state,paused:health.paused,tickMs:health.tickMs});
}
function startPolling() {
  clearInterval(app.pollTimer); app.pollTimer=setInterval(()=>loadSnapshot().catch(()=>{}),Math.max(2500,app.tickMs/2));
}
function connectSocket() {
  app.socket?.close(); clearTimeout(app.reconnectTimer);
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  const url=new URL(`${protocol}//${location.host}/api/stream`); url.searchParams.set("region",app.region);
  const socket=new WebSocket(url); app.socket=socket;
  socket.addEventListener("open",()=>{ setConnection("online","LIVE"); clearInterval(app.pollTimer); });
  socket.addEventListener("message",(event)=>{ try { applyEnvelope(JSON.parse(event.data)); } catch {} });
  socket.addEventListener("close",()=>{ if(app.socket!==socket)return; setConnection("offline","再接続中"); startPolling(); app.reconnectTimer=setTimeout(connectSocket,4000); });
  socket.addEventListener("error",()=>socket.close());
}
function populateRegions() {
  ui.regionSelect.replaceChildren();
  for (const region of app.regions) { const option=document.createElement("option"); option.value=region; option.textContent=region; option.selected=region===app.region; ui.regionSelect.append(option); }
}
async function connect() {
  clearInterval(app.pollTimer); app.socket?.close(); setConnection("","接続中"); ui.loading.classList.remove("hidden");
  try {
    const meta=await requestJson("/api/meta"); app.regions=meta.regions||[meta.defaultRegion||"garden-1"];
    if (!app.regions.includes(app.region)) app.region=meta.defaultRegion||app.regions[0]; populateRegions();
    await loadSnapshot(); connectSocket();
  } catch(error) {
    setConnection("offline","OFFLINE DEMO"); toast(`API未接続: ${error.message}`,true); applyEnvelope({state:createDemoState(),paused:false,tickMs:10_000});
    if (location.protocol!=="file:") app.reconnectTimer=setTimeout(connect,6000);
  }
}
async function admin(path,body={}) {
  try { const result=await requestJson(path,{method:"POST",headers:authHeaders(true),body:JSON.stringify(body)}); if(result.state)applyEnvelope({state:result.state,paused:app.paused,tickMs:app.tickMs}); else await loadSnapshot(); return result; }
  catch(error){ if(error.status===401)ui.settingsPanel.hidden=false; toast(error.message,true); throw error; }
}
ui.pauseButton.addEventListener("click",async()=>{ try { const result=await admin(app.paused?"/api/admin/resume":"/api/admin/pause"); app.paused=Boolean(result.paused); updateUi(); } catch{} });
ui.stepButton.addEventListener("click",()=>admin("/api/admin/tick",{count:1}).catch(()=>{}));
ui.resetButton.addEventListener("click",()=>{ if(confirm("現在の領域を初期状態へ戻しますか？"))admin("/api/admin/reset",{}).catch(()=>{}); });
ui.focusButton.addEventListener("click",()=>{ if(renderer.selectedAgentId)renderer.focusAgent(renderer.selectedAgentId); });
ui.settingsButton.addEventListener("click",()=>ui.settingsPanel.hidden=!ui.settingsPanel.hidden);
ui.settingsClose.addEventListener("click",()=>ui.settingsPanel.hidden=true);
ui.reconnectButton.addEventListener("click",()=>{
  app.region=ui.regionSelect.value||app.region; app.token=ui.tokenInput.value.trim();
  if(app.token)sessionStorage.setItem("moyo-token",app.token); else sessionStorage.removeItem("moyo-token");
  ui.settingsPanel.hidden=true; connect();
});

function createDemoState() {
  const width=24,height=16,tiles=[];
  for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){
    const edge=x===0||y===0||x===width-1||y===height-1;
    const river=Math.abs(x-12-Math.sin(y*.55)*2)<1;
    const terrain=edge||river?"water":((x*13+y*7)%17<3?"forest":(x*5+y*11)%23<4?"hill":"plain");
    let resource;
    if(terrain==="forest"&&(x+y)%2===0)resource={kind:"wood",amount:14,maxAmount:20};
    else if(terrain==="hill"&&(x+y)%2===0)resource={kind:"stone",amount:12,maxAmount:18};
    else if(terrain==="plain"&&(x*3+y)%19===0)resource={kind:"food",amount:9,maxAmount:14};
    tiles.push({x,y,terrain,...(resource?{resource}:{})});
  }
  const factions=[
    {id:"ember",name:"Ember Union",color:"#ef6c45",resources:{wood:34,stone:18,food:21},credits:0},
    {id:"azure",name:"Azure Compact",color:"#4f86e8",resources:{wood:29,stone:25,food:17},credits:0},
    {id:"verdant",name:"Verdant League",color:"#53a968",resources:{wood:42,stone:14,food:31},credits:0},
  ];
  const definitions=[["ember",4,4],["azure",19,4],["verdant",6,12]];
  const roles=["builder","woodcutter","miner","forager"],agents=[];
  for(const [factionId,sx,sy] of definitions)for(let i=0;i<4;i+=1)agents.push({
    id:`agent-${factionId}-${roles[i]}`,name:`${factionId[0].toUpperCase()}${roles[i].slice(0,4)}`,factionId,role:roles[i],
    position:{x:sx+i%2,y:sy+Math.floor(i/2)},hp:100,energy:100,capacity:12,inventory:{wood:i,stone:0,food:1},autonomy:true,
    goal:"地域資源を集めて自律集落を拡張する",status:i===0?"planning construction":"gathering resources",
  });
  const structures=definitions.flatMap(([factionId,x,y],index)=>[
    {id:`${factionId}-camp`,factionId,type:"camp",position:{x:x+1,y:y+1},status:"active",progress:6,requiredProgress:6,storage:{wood:8,stone:4,food:3}},
    ...(index===0?[{id:"ember-market",factionId,type:"market",position:{x:x+3,y:y+1},status:"active",progress:11,requiredProgress:11,storage:{wood:4,stone:2,food:2}}]:[]),
  ]);
  return {schemaVersion:1,worldId:"demo-world",regionId:"offline-demo",revision:1,tick:84,seed:424242,rngState:1,width,height,tiles,factions,agents,structures,
    events:[{id:"e1",tick:84,kind:"construction_completed",message:"Ember Union が市場を完成させた"},{id:"e2",tick:79,kind:"resources_deposited",message:"Verdant League が食料を共同備蓄へ搬入した"},{id:"e3",tick:72,kind:"world_started",message:"3勢力のBOTが開拓を開始した"}],processedCommandIds:[]};
}

connect();
