import { createInterface } from "node:readline";
import { api, post } from "./api.mjs";

const protocolVersion = "2026-07-28";
const tools = [
  { name: "list_agents", description: "List controllable agents in the selected MoYoGarden region.", inputSchema: { type: "object", properties: {} } },
  { name: "observe", description: "Get one agent's bounded local perception.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, radius: { type: "integer", minimum: 1, maximum: 12 } }, required: ["agentId"] } },
  { name: "act", description: "Submit one validated world command for an agent.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, command: { type: "object" } }, required: ["agentId", "command"] } },
  { name: "recent_events", description: "Read recent public world events.", inputSchema: { type: "object", properties: { afterTick: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 200 } } } },
  { name: "world_rules", description: "Read command, resource, structure and timing rules.", inputSchema: { type: "object", properties: {} } },
];

const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
async function callTool(name, args = {}) {
  if (name === "list_agents") return textResult(await api("/api/agents"));
  if (name === "observe") return textResult(await api(`/api/agents/${encodeURIComponent(args.agentId)}/perception?radius=${args.radius || 6}`));
  if (name === "act") return textResult(await post(`/api/agents/${encodeURIComponent(args.agentId)}/commands`, args.command));
  if (name === "recent_events") return textResult(await api(`/api/events?afterTick=${args.afterTick ?? -1}&limit=${args.limit || 100}`));
  if (name === "world_rules") return textResult(await api("/api/rules"));
  throw new Error(`unknown tool: ${name}`);
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  const id = request.id;
  try {
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "moyo-garden", version: "0.2.0" } } });
    } else if (request.method === "notifications/initialized") {
      // Notification; no response.
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (request.method === "tools/call") {
      send({ jsonrpc: "2.0", id, result: await callTool(request.params?.name, request.params?.arguments || {}) });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
});
