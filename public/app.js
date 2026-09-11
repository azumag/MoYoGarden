import * as THREE from "three";
import { createDemoState } from "./client/demo-state.js";
import { isHexGridCell } from "./client/hex-grid.js";
import { createLiveNeighborSimulation } from "./client/live-region-rendering.js";
import { ModelLibrary } from "./client/model-library.js";
import { resolveQualityProfile } from "./client/quality.js";
import { regionMetaUrl } from "./client/region-navigation.js";
import { mergeLiveTerrainWindow, terrainWindowTilesChanged } from "./client/terrain-window-cache.js";
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

const LIVE_REGION_WINDOW_REFRESH_MS = 10_000;
const NEIGHBOR_TERRAIN_REFRESH_MS = 60_000;
const FAR_TERRAIN_RADIUS = 2;

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
let liveNeighborSimulation;
let terrainWindowCenter;
let terrainWindowPayload;
let neighborTerrainUpdatedAt = 0;
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

  window.dispatchEvent(new CustomEvent("moyo:neighbor-topology", {
    detail: { payload, centerRegionId: app.region },
  }));

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

async function loadTerrainWindow(force = false) {
  if (!app.state || (!force && terrainWindowCenter === app.region && neighborPreviewRoot)) return;
  const requestedRegion = app.region;
  try {
    const payload = await requestJson(`/api/world/window?radius=${FAR_TERRAIN_RADIUS}&terrain=1`, {}, 12_000);
    if (requestedRegion !== app.region) return;
    buildNeighborPreview(payload);
    terrainWindowPayload = payload;
    terrainWindowCenter = app.region;
    neighborTerrainUpdatedAt = Date.now();
  } catch (error) {
    console.debug("MoYoGarden outer terrain window skipped", error);
  }
}

function refreshNearTerrainFromLive(payload) {
  if (!terrainWindowPayload || terrainWindowCenter !== app.region) return;
  const now = Date.now();
  if (now - neighborTerrainUpdatedAt < NEIGHBOR_TERRAIN_REFRESH_MS) return;
  const previousTerrainWindow = terrainWindowPayload;
  const mergedTerrainWindow = mergeLiveTerrainWindow(previousTerrainWindow, payload);
  terrainWindowPayload = mergedTerrainWindow;
  if (terrainWindowTilesChanged(previousTerrainWindow, mergedTerrainWindow, app.region)) {
    buildNeighborPreview(mergedTerrainWindow);
  }
  neighborTerrainUpdatedAt = now;
}

async function loadRegionWindow() {
  if (!app.state || app.regions.length < 2) {
    liveNeighborSimulation?.setCenter(app.region);
    return;
  }
  const requestedRegion = app.region;
  try {
    const payload = await requestJson("/api/world/window?radius=1&live=1", {}, 10_000);
    if (requestedRegion !== app.region) return;
    liveNeighborSimulation?.syncWindow(payload, app.region, LIVE_REGION_WINDOW_REFRESH_MS);
    refreshNearTerrainFromLive(payload);
  } catch (error) {
    console.debug("MoYoGarden live neighbor window skipped", error);
  }
}

function startRegionWindowRefresh() {
  clearInterval(app.windowTimer);
  app.windowTimer = setInterval(() => { void loadRegionWindow(); }, LIVE_REGION_WINDOW_REFRESH_MS);
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
  if (!app.state || !view.selectedAgentId) {
    ui.agentEmpty.hidden = false;
    ui.agentDetail.hidden = true;
    return;
  }
  const agent = app.state.agents.find((entry) => entry.id === view.selectedAgentId);
  if (!agent) {
    ui.agentEmpty.hidden = false;
    ui.agentDetail.hidden = true;
    return;
  }
  const faction = app.state.factions.find((entry) => entry.id === agent.factionId);
  ui.agentEmpty.hidden = true;
  ui.agentDetail.hidden = false;
  ui.agentSwatch.style.background = faction?.color || "#999";
  ui.agentName.textContent = agent.name;
  ui.agentRole.textContent = ROLE_LABELS[agent.role] || agent.role;
  ui.agentFaction.textContent = faction?.name || agent.factionId;
  ui.agentPosition.textContent = `${agent.position.x}, ${agent.position.y}`;
  ui.agentHp.textContent = `${Math.round(agent.health)} / ${Math.round(agent.energy)}`;
  ui.agentAutonomy.textContent = agent.autonomyEnabled === false ? "OFF" : "ON";
  ui.agentStatus.textContent = agent.status || "idle";
  ui.invWood.textContent = String(agent.inventory.wood || 0);
  ui.invStone.textContent = String(agent.inventory.stone || 0);
  ui.invFood.textContent = String(agent.inventory.food || 0);
  ui.agentGoal.textContent = agent.goal || "—";
}

async function refreshMeta() {
  const meta = await requestJson("/api/meta");
  const regions = meta.world?.regionTopology?.regions;
  if (Array.isArray(regions) && regions.length > 0) {
    app.regions = regions.map((entry) => entry.id).filter(Boolean);
  } else if (Array.isArray(meta.regions) && meta.regions.length > 0) {
    app.regions = meta.regions;
  }
  const targetRegion = meta.defaultRegion && app.regions.includes(meta.defaultRegion)
    ? meta.defaultRegion
    : app.regions.includes(app.region)
      ? app.region
      : app.regions[0] || app.region;
  app.region = targetRegion;
  ui.regionSelect.replaceChildren();
  for (const region of app.regions) {
    const option = document.createElement("option");
    option.value = region;
    option.textContent = region;
    ui.regionSelect.append(option);
  }
  ui.regionSelect.value = app.region;
}

function connectSocket() {
  if (app.socket) app.socket.close();
  setConnection("pending", "接続中");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${location.host}/api/stream`);
  url.searchParams.set("region", app.region);
  app.socket = new WebSocket(url);
  app.socket.onopen = () => setConnection("good", "リアルタイム");
  app.socket.onmessage = (event) => {
    try {
      applyEnvelope(JSON.parse(event.data));
    } catch (error) {
      console.warn("MoYoGarden stream payload failed", error);
    }
  };
  app.socket.onerror = () => setConnection("bad", "接続エラー");
  app.socket.onclose = () => {
    setConnection("pending", "再接続中");
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = setTimeout(connectSocket, 2_000);
  };
}

async function pollSnapshot() {
  try {
    const snapshot = await requestJson("/api/snapshot");
    applyEnvelope(snapshot);
    setConnection("good", "ポーリング");
  } catch (error) {
    console.debug("MoYoGarden snapshot poll failed", error);
    setConnection("bad", "切断");
  }
}

function startPolling() {
  clearInterval(app.pollTimer);
  app.pollTimer = setInterval(() => { void pollSnapshot(); }, 10_000);
}

async function loadInitialState() {
  try {
    const snapshot = await requestJson("/api/snapshot");
    applyEnvelope(snapshot);
  } catch (error) {
    console.warn("MoYoGarden API unavailable; using demo state", error);
    applyEnvelope({ state: createDemoState(), tickMs: 10_000 });
  }
}

async function sendCommand(command) {
  try {
    const result = await requestJson("/api/command", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(command),
    });
    applyEnvelope(result);
    toast("コマンドを送信しました");
    return true;
  } catch (error) {
    toast(error.message || "コマンドに失敗しました", true);
    return false;
  }
}

async function switchRegion(regionId) {
  if (!app.regions.includes(regionId) || regionId === app.region) return;
  app.region = regionId;
  ui.regionSelect.value = regionId;
  clearNeighborPreview();
  liveNeighborSimulation?.setCenter(regionId);
  terrainWindowCenter = undefined;
  terrainWindowPayload = undefined;
  neighborTerrainUpdatedAt = 0;
  await loadInitialState();
  await loadTerrainWindow(true);
  await loadRegionWindow();
  connectSocket();
  toast(`${regionId} に移動しました`);
}

function bindUi() {
  ui.pauseButton.addEventListener("click", () => { void sendCommand({ type: "pause", id: crypto.randomUUID() }); });
  ui.stepButton.addEventListener("click", () => { void sendCommand({ type: "step", id: crypto.randomUUID() }); });
  ui.resetButton.addEventListener("click", () => { void sendCommand({ type: "reset", id: crypto.randomUUID() }); });
  ui.focusButton.addEventListener("click", () => {
    if (view.selectedAgentId) view.focusAgent(view.selectedAgentId);
    else view.focusCenter();
  });
  ui.settingsButton.addEventListener("click", () => { ui.settingsPanel.hidden = false; });
  ui.settingsClose.addEventListener("click", () => { ui.settingsPanel.hidden = true; });
  ui.regionSelect.addEventListener("change", () => { void switchRegion(ui.regionSelect.value); });
  ui.tokenInput.addEventListener("change", () => {
    app.token = ui.tokenInput.value.trim();
    sessionStorage.setItem("moyo-token", app.token);
  });
  ui.reconnectButton.addEventListener("click", () => {
    connectSocket();
    void pollSnapshot();
  });
  window.addEventListener("moyo:auto-region-handoff", (event) => {
    const regionId = event?.detail?.regionId;
    if (typeof regionId === "string" && app.regions.includes(regionId) && regionId !== app.region) {
      void switchRegion(regionId);
    }
  });
}

async function initModels() {
  if (quality.loadModels === false) {
    renderState.modelsTotal = 0;
    updateRenderStatus();
    return;
  }
  const result = await models.load({
    timeoutMs: quality.modelTimeoutMs,
    concurrency: quality.modelConcurrency,
    onProgress: ({ completed, total }) => {
      renderState.modelsLoaded = completed;
      renderState.modelsTotal = total;
      updateRenderStatus();
    },
    onModelLoaded: ({ key }) => {
      view.refreshModelType(key);
      liveNeighborSimulation?.refreshModelType(key);
    },
  });
  renderState.modelsLoaded = result.loaded.length;
  renderState.modelsFailed = result.failed.length;
  renderState.modelsTotal = models.size;
  updateRenderStatus();
}

async function initialize() {
  if (ui.loadingProgress) ui.loadingProgress.value = 0.08;
  updateRenderStatus();
  await refreshMeta();
  if (ui.loadingProgress) ui.loadingProgress.value = 0.18;
  view = new WorldView(ui.canvas, models, quality);
  liveNeighborSimulation = createLiveNeighborSimulation(view);
  window.moyoWorldView = view;
  if (ui.loadingProgress) ui.loadingProgress.value = 0.32;
  bindUi();
  await loadInitialState();
  if (ui.loadingProgress) ui.loadingProgress.value = 0.48;
  void loadTerrainWindow();
  void loadRegionWindow();
  connectSocket();
  startPolling();
  startRegionWindowRefresh();
  if (ui.loadingProgress) ui.loadingProgress.value = 0.62;
  if (location.protocol !== "file:") void initModels();
  if (ui.loadingProgress) ui.loadingProgress.value = 0.72;
  view.focusCenter();
  view.animate();
  if (!readyDispatched) {
    readyDispatched = true;
    window.dispatchEvent(new CustomEvent("moyo:pbr-ready"));
  }
  if (ui.loadingProgress) ui.loadingProgress.value = 1;
}

initialize().catch((error) => {
  console.error("MoYoGarden PBR startup failed", error);
  window.dispatchEvent(new CustomEvent("moyo:pbr-error", { detail: { error } }));
});
