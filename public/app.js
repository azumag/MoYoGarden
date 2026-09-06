import * as THREE from "three";
import { createDemoState } from "./client/demo-state.js";
import { isHexGridCell } from "./client/hex-grid.js";
import { ModelLibrary } from "./client/model-library.js";
import { resolveQualityProfile } from "./client/quality.js";
import { regionMetaUrl } from "./client/region-navigation.js";
import { ROLE_LABELS, TERRAIN_COLORS, disposeObject } from "./client/shared.js";
import { WorldView } from "./client/world-view.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  canvas: $("#world"),
  loading: $("#loading"),
  loadingLabel: $("#loading-label"),
  loadingDetail: $("#loading-detail"),
  loadingProgress: $("#loading-progress"),
  toast: $("#toast"),
  connectionDot: $("#connection-dot"),
  connectionLabel: $("#connection-label"),
  regionLabel: $("#region-label"),
  tickLabel: $("#tick-label"),
  agentCount: $("#agent-count"),
  structureCount: $("#structure-count"),
  renderStatus: $("#render-status"),
  pauseButton: $("#pause-button"),
  stepButton: $("#step-button"),
  resetButton: $("#reset-button"),
  focusButton: $("#focus-button"),
  settingsButton: $("#settings-button"),
  settingsPanel: $("#settings-panel"),
  settingsClose: $("#settings-close"),
  regionSelect: $("#region-select"),
  tokenInput: $("#token-input"),
  reconnectButton: $("#reconnect-button"),
  agentEmpty: $("#agent-empty"),
  agentDetail: $("#agent-detail"),
  agentSwatch: $("#agent-swatch"),
  agentName: $("#agent-name"),
  agentRole: $("#agent-role"),
  agentFaction: $("#agent-faction"),
  agentPosition: $("#agent-position"),
  agentHp: $("#agent-hp"),
  agentAutonomy: $("#agent-autonomy"),
  agentStatus: $("#agent-status"),
  invWood: $("#inv-wood"),
  invStone: $("#inv-stone"),
  invFood: $("#inv-food"),
  agentGoal: $("#agent-goal"),
  factionList: $("#faction-list"),
  eventList: $("#event-list"),
  pausedBadge: $("#paused-badge"),
};

const quality = resolveQualityProfile();
const models = new ModelLibrary();
const renderState = {
  modelsLoaded: 0,
  modelsFailed: 0,
  modelsTotal: models.size,
  environment: false,
  shadows: false,
  neighborChunks: 0,
};
const app = {
  state: null,
  paused: false,
  tickMs: 10_000,
  region: "garden-1",
  regions: ["garden-1"],
  token: sessionStorage.getItem("moyo-token") || "",
  socket: null,
  pollTimer: null,
  windowTimer: null,
  reconnectTimer: null,
};
ui.tokenInput.value = app.token;

let view;
let toastTimer;
let neighborPreviewRoot;
let readyDispatched = false;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.className = `toast show${error ? " error" : ""}`;
  toastTimer = setTimeout(() => { ui.toast.className = "toast"; }, 2_800);
}

function setConnection(mode, label) {
  ui.connectionDot.className = `connection-dot ${mode}`;
  ui.connectionLabel.textContent = label;
}

function updateRenderStatus() {
  const parts = [quality.label];
  if (renderState.modelsLoaded > 0) parts.push(`GLB ${renderState.modelsLoaded}/${renderState.modelsTotal}`);
  else parts.push("LOD FALLBACK");
  if (renderState.neighborChunks > 0) parts.push(`CHUNK +${renderState.neighborChunks}`);
  if (renderState.shadows) parts.push("SHADOW");
  if (renderState.environment) parts.push("IBL");
  if (renderState.modelsFailed > 0) parts.push(`MISS ${renderState.modelsFailed}`);
  ui.renderStatus.textContent = parts.join(" · ");
  ui.renderStatus.title = `quality=${quality.id}`;
}

function authHeaders(jsonBody = false) {
  const headers = {};
  if (jsonBody) headers["content-type"] = "application/json";
  if (app.token) headers.authorization = `Bearer ${app.token}`;
  return headers;
}

function apiUrl(path) {
  const url = new URL(path === "/api/meta" ? regionMetaUrl(app.region, 1) : path, location.origin);
  if (path !== "/api/meta") url.searchParams.set("region", app.region);
  return url;
}

async function requestJson(path, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function previewTerrainHeight(tile) {
  if (!tile || tile.terrain === "water") return -0.24;
  if (Number.isFinite(tile.elevation)) {
    return 0.015 + Math.pow(Math.max(0, Math.min(1, tile.elevation)), 1.18) * 0.82;
  }
  if (tile.terrain === "hill") return 0.54;
  if (tile.terrain === "forest") return 0.11;
  return 0.015;
}

function clearNeighborPreview() {
  if (neighborPreviewRoot) disposeObject(neighborPreviewRoot);
  neighborPreviewRoot = undefined;
  renderState.neighborChunks = 0;
  updateRenderStatus();
}

function buildNeighborPreview(payload) {
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
  const center = chunks.find((chunk) => chunk.regionId === app.region && chunk.state?.tiles);
  if (!center || !app.state) {
    clearNeighborPreview();
    return;
  }

  const land = [];
  const water = [];
  let neighborChunks = 0;
  for (const chunk of chunks) {
    if (chunk.regionId === app.region || !chunk.state?.tiles || !chunk.origin) continue;
    neighborChunks += 1;
    const offsetX = chunk.origin.x - center.origin.x;
    const offsetY = chunk.origin.y - center.origin.y;
    const chunkWidth = Number(chunk.state.width) || app.state.width;
    const chunkHeight = Number(chunk.state.height) || app.state.height;
    for (const tile of chunk.state.tiles) {
      if (!isHexGridCell(tile, chunkWidth, chunkHeight)) continue;
      const color = (TERRAIN_COLORS[tile.terrain] || TERRAIN_COLORS.plain).clone();
      const elevation = Number.isFinite(tile.elevation) ? tile.elevation : 0.5;
      color.offsetHSL(0, 0, (elevation - 0.5) * 0.045);
      const entry = {
        x: offsetX + tile.x - app.state.width / 2 + 0.5,
        z: offsetY + tile.y - app.state.height / 2 + 0.5,
        y: previewTerrainHeight(tile),
        color,
      };
      if (tile.terrain === "water") water.push(entry);
      else land.push(entry);
    }
  }

  clearNeighborPreview();
  if (neighborChunks === 0) return;

  const root = new THREE.Group();
  root.name = "neighbor-region-preview";
  const matrix = new THREE.Matrix4();

  if (land.length > 0) {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.985, 0.08, 0.985),
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.99,
        metalness: 0,
        envMapIntensity: 0.2,
      }),
      land.length,
    );
    land.forEach((entry, index) => {
      matrix.makeTranslation(entry.x, entry.y - 0.04, entry.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, entry.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }

  if (water.length > 0) {
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.985, 0.985),
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.24,
        metalness: 0.02,
        transparent: true,
        opacity: 0.67,
        depthWrite: false,
        envMapIntensity: 0.7,
      }),
      water.length,
    );
    water.forEach((entry, index) => {
      matrix.makeRotationX(-Math.PI / 2);
      matrix.setPosition(entry.x, entry.y + 0.035, entry.z);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, entry.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 1;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }

  neighborPreviewRoot = root;
  view.worldRoot.add(root);
  renderState.neighborChunks = neighborChunks;
  view.markShadowsDirty();
  updateRenderStatus();
}

async function loadRegionWindow() {
  if (!app.state || app.regions.length < 2) {
    clearNeighborPreview();
    return;
  }
  const requestedRegion = app.region;
  try {
    const payload = await requestJson("/api/world/window?radius=1", {}, 10_000);
    if (requestedRegion !== app.region) return;
    buildNeighborPreview(payload);
  } catch (error) {
    console.debug("MoYoGarden neighbor region prefetch skipped", error);
  }
}

function startRegionWindowRefresh() {
  clearInterval(app.windowTimer);
  app.windowTimer = setInterval(() => { void loadRegionWindow(); }, 60_000);
}

function applyEnvelope(value) {
  const state = value?.state || value;
  if (!state?.tiles || !state?.agents) return;
  app.state = state;
  app.paused = Boolean(value?.paused ?? app.paused);
  app.tickMs = Number(value?.tickMs) || app.tickMs;
  view.setState(state, app.tickMs);
  updateUi();
}

function updateUi() {
  const state = app.state;
  if (!state) return;
  ui.regionLabel.textContent = state.regionId;
  ui.tickLabel.textContent = String(state.tick);
  ui.agentCount.textContent = String(state.agents.length);
  ui.structureCount.textContent = String(state.structures.length);
  ui.pausedBadge.hidden = !app.paused;
  ui.pauseButton.textContent = app.paused ? "再開" : "一時停止";

  ui.factionList.replaceChildren();
  for (const faction of state.factions) {
    const card = document.createElement("div");
    card.className = "faction-card";
    const stripe = document.createElement("i");
    stripe.style.background = faction.color;
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = faction.name;
    const count = document.createElement("small");
    count.textContent = `BOT ${state.agents.filter((agent) => agent.factionId === faction.id).length} / 建物 ${state.structures.filter((structure) => structure.factionId === faction.id).length}`;
    info.append(name, count);
    const resources = document.createElement("code");
    resources.textContent = `木${faction.resources.wood} 石${faction.resources.stone} 食${faction.resources.food}`;
    card.append(stripe, info, resources);
    ui.factionList.append(card);
  }

  ui.eventList.replaceChildren();
  for (const event of state.events.slice(-12).reverse()) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = `T${event.tick}`;
    item.append(time, document.createTextNode(event.message));
    ui.eventList.append(item);
  }
  updateAgentDetail();
}

function updateAgentDetail() {
  const state = app.state;
  const agent = state?.agents.find((entry) => entry.id === view.selectedAgentId);
  if (!agent) {
    ui.agentEmpty.hidden = false;
    ui.agentDetail.hidden = true;
    return;
  }
  const faction = state.factions.find((entry) => entry.id === agent.factionId);
  ui.agentEmpty.hidden = true;
  ui.agentDetail.hidden = false;
  ui.agentSwatch.style.background = faction?.color || "#c8ff66";
  ui.agentName.textContent = agent.name;
  ui.agentRole.textContent = ROLE_LABELS[agent.role] || agent.role;
  ui.agentFaction.textContent = faction?.name || agent.factionId;
  ui.agentPosition.textContent = `${agent.position.x}, ${agent.position.y}`;
  ui.agentHp.textContent = String(agent.hp);
  ui.agentAutonomy.textContent = agent.autonomy ? "ON" : "OFF";
  ui.agentStatus.textContent = agent.status;
  ui.invWood.textContent = String(agent.inventory.wood);
  ui.invStone.textContent = String(agent.inventory.stone);
  ui.invFood.textContent = String(agent.inventory.food);
  ui.agentGoal.textContent = agent.goal || "目標未設定";
}

async function loadSnapshot() {
  const [state, health] = await Promise.all([
    requestJson("/api/world/snapshot"),
    requestJson("/api/health"),
  ]);
  applyEnvelope({ state, paused: health.paused, tickMs: health.tickMs });
}

function startPolling() {
  clearInterval(app.pollTimer);
  app.pollTimer = setInterval(
    () => loadSnapshot().catch(() => {}),
    Math.max(2_500, app.tickMs / 2),
  );
}

function connectSocket() {
  app.socket?.close();
  clearTimeout(app.reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/stream`);
  url.searchParams.set("region", app.region);
  const socket = new WebSocket(url);
  app.socket = socket;
  socket.addEventListener("open", () => {
    setConnection("online", "LIVE");
    clearInterval(app.pollTimer);
  });
  socket.addEventListener("message", (event) => {
    try { applyEnvelope(JSON.parse(event.data)); } catch {}
  });
  socket.addEventListener("close", () => {
    if (app.socket !== socket) return;
    setConnection("offline", "再接続中");
    startPolling();
    app.reconnectTimer = setTimeout(connectSocket, 4_000);
  });
  socket.addEventListener("error", () => socket.close());
}

function populateRegions() {
  ui.regionSelect.replaceChildren();
  for (const region of app.regions) {
    const option = document.createElement("option");
    option.value = region;
    option.textContent = region;
    option.selected = region === app.region;
    ui.regionSelect.append(option);
  }
}

async function connect() {
  clearInterval(app.pollTimer);
  clearInterval(app.windowTimer);
  app.socket?.close();
  clearNeighborPreview();
  setConnection("", "同期中");
  try {
    const meta = await requestJson("/api/meta");
    app.regions = meta.regions || [meta.defaultRegion || "garden-1"];
    if (!app.regions.includes(app.region)) app.region = meta.defaultRegion || app.regions[0];
    populateRegions();
    await loadSnapshot();
    void loadRegionWindow();
    startRegionWindowRefresh();
    connectSocket();
  } catch (error) {
    if (!app.state) {
      applyEnvelope({ state: createDemoState(), paused: false, tickMs: 10_000 });
    }
    setConnection("offline", "OFFLINE DEMO");
    toast(`API未接続: ${error.message}`, true);
    startPolling();
    if (location.protocol !== "file:") app.reconnectTimer = setTimeout(connect, 6_000);
  }
}

async function loadHighResolutionModels() {
  const result = await models.load({
    timeoutMs: quality.modelTimeoutMs,
    concurrency: quality.modelConcurrency,
    onProgress: ({ completed, total, key }) => {
      if (ui.loadingDetail) ui.loadingDetail.textContent = `背景読込: ${key} ${completed}/${total}`;
      if (ui.loadingProgress) ui.loadingProgress.value = completed / total;
    },
    onModelLoaded: ({ key }) => {
      renderState.modelsLoaded += 1;
      view.refreshModelType(key);
      updateRenderStatus();
    },
  });
  renderState.modelsFailed = result.failed.length;
  updateRenderStatus();
  if (result.failed.length > 0) {
    console.warn("MoYoGarden model fallbacks:", result.failed);
    toast(`${result.failed.length}種類のモデルを軽量LODで表示します`, true);
  }
}

async function admin(path, body = {}) {
  try {
    const result = await requestJson(path, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    if (result.state) applyEnvelope({ state: result.state, paused: app.paused, tickMs: app.tickMs });
    else await loadSnapshot();
    return result;
  } catch (error) {
    if (error.status === 401) ui.settingsPanel.hidden = false;
    toast(error.message, true);
    throw error;
  }
}

function bindUi() {
  ui.pauseButton.addEventListener("click", async () => {
    try {
      const result = await admin(app.paused ? "/api/admin/resume" : "/api/admin/pause");
      app.paused = Boolean(result.paused);
      updateUi();
    } catch {}
  });
  ui.stepButton.addEventListener("click", () => admin("/api/admin/tick", { count: 1 }).catch(() => {}));
  ui.resetButton.addEventListener("click", () => {
    if (confirm("現在の領域を初期状態へ戻しますか？")) admin("/api/admin/reset", {}).catch(() => {});
  });
  ui.focusButton.addEventListener("click", () => {
    if (view.selectedAgentId) view.focusAgent(view.selectedAgentId);
  });
  ui.settingsButton.addEventListener("click", () => {
    ui.settingsPanel.hidden = !ui.settingsPanel.hidden;
  });
  ui.settingsClose.addEventListener("click", () => { ui.settingsPanel.hidden = true; });
  ui.reconnectButton.addEventListener("click", () => {
    app.region = ui.regionSelect.value || app.region;
    app.token = ui.tokenInput.value.trim();
    if (app.token) sessionStorage.setItem("moyo-token", app.token);
    else sessionStorage.removeItem("moyo-token");
    ui.settingsPanel.hidden = true;
    connect();
  });
}

async function initialize() {
  updateRenderStatus();
  ui.loadingLabel.textContent = "本番ワールドに接続しています";
  ui.loadingDetail.textContent = `${quality.label}プロファイル`;

  view = new WorldView(ui.canvas, models, quality);
  view.onSelect = updateAgentDetail;
  view.onCommand = async (agentId, target) => {
    try {
      await requestJson(`/api/agents/${encodeURIComponent(agentId)}/commands`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          id: `web-move-${crypto.randomUUID()}`,
          type: "move",
          target,
        }),
      });
      toast(`移動命令: ${target.x}, ${target.y}`);
    } catch (error) {
      if (error.status === 401) ui.settingsPanel.hidden = false;
      toast(error.message, true);
    }
  };
  view.onEnhancement = ({ feature, active }) => {
    if (feature === "environment") renderState.environment = active;
    if (feature === "shadows") renderState.shadows = active;
    updateRenderStatus();
  };

  bindUi();
  setConnection("", "同期中");
  await connect();

  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  ui.loading.classList.add("hidden");
  if (!readyDispatched) {
    readyDispatched = true;
    window.dispatchEvent(new CustomEvent("moyo:pbr-ready", {
      detail: { quality: quality.id, startup: "procedural-lod" },
    }));
  }

  view.startEnhancements();
  setTimeout(() => { void loadHighResolutionModels(); }, 80);
}

try {
  await initialize();
} catch (error) {
  console.error(error);
  window.dispatchEvent(new CustomEvent("moyo:pbr-error", { detail: { error } }));
}