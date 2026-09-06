import { hexCellRadius } from "./hex-grid.js";
import { WorldView } from "./world-view.js";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_SPREAD_RATIO = 0.78;

function stablePhase(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 * Math.PI * 2;
}

function crowdSpreadRatio(count) {
  return Math.min(MAX_SPREAD_RATIO, 0.28 + Math.log2(Math.max(2, count)) * 0.09);
}

/**
 * Give agents sharing one logical simulation hex stable micro-positions for
 * rendering only. Simulation coordinates remain unchanged; this only prevents
 * dozens of models from occupying the exact same world-space point.
 */
export function buildAgentCrowdLayout(agents, cellRadius = 1) {
  const safeRadius = Number.isFinite(cellRadius) && cellRadius > 0 ? cellRadius : 1;
  const groups = new Map();
  const layout = new Map();

  for (const agent of agents ?? []) {
    if (
      typeof agent?.id !== "string"
      || !Number.isFinite(agent?.position?.x)
      || !Number.isFinite(agent?.position?.y)
    ) continue;
    const key = `${agent.position.x}:${agent.position.y}`;
    const group = groups.get(key) ?? [];
    group.push(agent.id);
    groups.set(key, group);
  }

  for (const [key, ids] of groups) {
    ids.sort((a, b) => a.localeCompare(b));
    if (ids.length === 1) {
      layout.set(ids[0], { x: 0, z: 0 });
      continue;
    }

    const maximumRadius = safeRadius * crowdSpreadRatio(ids.length);
    const phase = stablePhase(key);
    for (let index = 0; index < ids.length; index += 1) {
      const normalizedRadius = Math.sqrt((index + 0.5) / ids.length);
      const angle = phase + index * GOLDEN_ANGLE;
      const distance = maximumRadius * normalizedRadius;
      layout.set(ids[index], {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
      });
    }
  }

  return layout;
}

const baseSyncAgents = WorldView.prototype.syncAgents;
WorldView.prototype.syncAgents = function syncAgentsWithCrowdSeparation(state) {
  const existing = new Set(this.agentObjects?.keys?.() ?? []);
  baseSyncAgents.call(this, state);
  if (!Array.isArray(state?.agents) || state.agents.length === 0) return;

  const radius = hexCellRadius(state.width, state.height);
  const layout = buildAgentCrowdLayout(state.agents, radius);
  const now = performance.now();

  for (const agent of state.agents) {
    const entry = this.agentObjects.get(agent.id);
    if (!entry) continue;
    const offset = layout.get(agent.id) ?? { x: 0, z: 0 };
    const target = this.worldPosition(agent.position, 0);
    target.x += offset.x;
    target.z += offset.z;

    if (!existing.has(agent.id)) {
      entry.lod.position.copy(target);
      entry.from.copy(target);
      entry.to.copy(target);
    } else {
      entry.from.copy(entry.lod.position);
      entry.to.copy(target);
    }
    entry.start = now;
  }
};
