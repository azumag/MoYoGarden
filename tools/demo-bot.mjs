import { api, post } from "./api.mjs";

const intervalMs = Math.max(2_000, Number(process.env.BOT_INTERVAL_MS || 10_000));
const configuredAgent = process.env.AGENT_ID || "";

function chooseMove(perception) {
  const candidates = perception.visibleTiles.filter((tile) => tile.terrain !== "water");
  candidates.sort((a, b) => {
    const ar = a.resource?.amount || 0;
    const br = b.resource?.amount || 0;
    return br - ar || Math.abs(a.x - perception.self.position.x) - Math.abs(b.x - perception.self.position.x);
  });
  return candidates[0];
}

async function runOnce() {
  const agents = await api("/api/agents");
  const agent = agents.find((entry) => entry.id === configuredAgent) || agents[0];
  if (!agent) throw new Error("no agents are available");
  const perception = await api(`/api/agents/${encodeURIComponent(agent.id)}/perception?radius=6`);
  const tile = chooseMove(perception);
  if (!tile) return;
  const command = {
    id: `demo-${agent.id}-${perception.tick}-${tile.x}-${tile.y}`,
    type: "move",
    target: { x: tile.x, y: tile.y },
  };
  const receipt = await post(`/api/agents/${encodeURIComponent(agent.id)}/commands`, command);
  console.log(JSON.stringify({ agentId: agent.id, tick: perception.tick, command, receipt }));
}

console.error(`MoYoGarden demo bot started; interval=${intervalMs}ms`);
await runOnce();
setInterval(() => runOnce().catch((error) => console.error(error.message)), intervalMs);
