import { createDemoState } from "./client/demo-state.js";
import { ModelLibrary } from "./client/model-library.js";
import { ROLE_LABELS } from "./client/shared.js";
import { WorldView } from "./client/world-view.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  canvas: $("#world"),
  loading: $("#loading"),
  loadingLabel: $("#loading-label"),
  toast: $("#toast"),
  connectionDot: $("#connection-dot"),
  connectionLabel: $("#connection-label"),
  regionLabel: $("#region-label"),
  tickLabel: $("#tick-label"),
  agentCount: $("#agent-count"),
  structureCount: $("#structure-count"),
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

const app = {
  state: null,
  paused: false,
  tickMs: 10_000,
  region: "garden-1",
  regions: ["garden-1"],
  token: sessionStorage.getItem("moyo-token") || "",
  socket: null,
  pollTimer: null,
  reconnectTimer: null,
};
ui.tokenInput.value = app.token;

let view;
let toastTimer;

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

function authHeaders(jsonBody = false) {
  const headers = {};
  if (jsonBody) headers["content-type"] = "application/json";
  if (app.token) headers.authorization = `Bearer ${app.token}`;
  return headers;
}

function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (path !== "/api/meta") url.searchParams.set("region", app.region);
  return url;
}

async function requestJson(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function applyEnvelope(value) {
  const state = value?.state || value;
  if (!state?.tiles || !state?.agents) return;
  app.state = state;
  app.paused = Boolean(value?.paused ?? app.paused);
  app.tickMs = Number(value?.tickMs) || app.tickMs;
  view.setState(state, app.tickMs);
  updateUi();
  ui.loading.classList.add("hidden");
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
  app.socket?.close();
  setConnection("", "接続中");
  ui.loading.classList.remove("hidden");
  ui.loadingLabel.textContent = "永続ワールドを同期しています";
  try {
    const meta = await requestJson("/api/meta");
    app.regions = meta.regions || [meta.defaultRegion || "garden-1"];
    if (!app.regions.includes(app.region)) {
      app.region = meta.defaultRegion || app.regions[0];
    }
    populateRegions();
    await loadSnapshot();
    connectSocket();
  } catch (error) {
    setConnection("offline", "OFFLINE DEMO");
    toast(`API未接続: ${error.message}`, true);
    applyEnvelope({ state: createDemoState(), paused: false, tickMs: 10_000 });
    if (location.protocol !== "file:") {
      app.reconnectTimer = setTimeout(connect, 6_000);
    }
  }
}

async function admin(path, body = {}) {
  try {
    const result = await requestJson(path, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    if (result.state) {
      applyEnvelope({ state: result.state, paused: app.paused, tickMs: app.tickMs });
    } else {
      await loadSnapshot();
    }
    return result;
  } catch (error) {
    if (error.status === 401) ui.settingsPanel.hidden = false;
    toast(error.message, true);
    throw error;
  }
}

async function initializeRenderer() {
  const models = new ModelLibrary();
  ui.loadingLabel.textContent = "glTF / PBRモデルを読み込んでいます";
  try {
    await models.load();
  } catch (error) {
    console.warn("glTF model load failed; using procedural LOD fallbacks", error);
    toast("glTFモデルを取得できないため軽量表示で続行します", true);
  }
  view = new WorldView(ui.canvas, models);
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
}

ui.pauseButton.addEventListener("click", async () => {
  try {
    const result = await admin(app.paused ? "/api/admin/resume" : "/api/admin/pause");
    app.paused = Boolean(result.paused);
    updateUi();
  } catch {}
});
ui.stepButton.addEventListener("click", () => admin("/api/admin/tick", { count: 1 }).catch(() => {}));
ui.resetButton.addEventListener("click", () => {
  if (confirm("現在の領域を初期状態へ戻しますか？")) {
    admin("/api/admin/reset", {}).catch(() => {});
  }
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

try {
  await initializeRenderer();
  await connect();
} catch (error) {
  ui.loadingLabel.textContent = `3D初期化に失敗しました: ${error?.message || error}`;
  setConnection("offline", "RENDER ERROR");
  console.error(error);
}
