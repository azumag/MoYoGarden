import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAgentCrowdLayout } from "../public/client/agent-crowding.js";

function offset(layout, id) {
  return layout.get(id) ?? { x: 0, z: 0 };
}

function key(point) {
  return `${point.x.toFixed(6)}:${point.z.toFixed(6)}`;
}

test("agents sharing one logical hex receive distinct deterministic visual offsets", () => {
  const agents = [
    { id: "agent-c", position: { x: 10, y: 14 } },
    { id: "agent-a", position: { x: 10, y: 14 } },
    { id: "agent-b", position: { x: 10, y: 14 } },
    { id: "agent-alone", position: { x: 11, y: 14 } },
  ];
  const first = buildAgentCrowdLayout(agents, 1);
  const second = buildAgentCrowdLayout([...agents].reverse(), 1);

  assert.deepEqual(offset(first, "agent-alone"), { x: 0, z: 0 });
  assert.equal(new Set(["agent-a", "agent-b", "agent-c"].map((id) => key(offset(first, id)))).size, 3);
  for (const id of agents.map((agent) => agent.id)) assert.deepEqual(offset(first, id), offset(second, id));
});

test("dense crowds stay bounded to the logical hex while retaining unique micro-positions", () => {
  const agents = Array.from({ length: 64 }, (_, index) => ({
    id: `agent-${String(index).padStart(2, "0")}`,
    position: { x: 14, y: 5 },
  }));
  const layout = buildAgentCrowdLayout(agents, 1);
  const points = agents.map((agent) => offset(layout, agent.id));

  assert.equal(new Set(points.map(key)).size, agents.length);
  for (const point of points) assert.ok(Math.hypot(point.x, point.z) <= 0.78 + 1e-9);
});

test("boot installs crowd separation before the main application starts", async () => {
  const source = await readFile(new URL("../public/boot.js", import.meta.url), "utf8");
  const crowdImport = source.indexOf("/client/agent-crowding.js");
  const appLaunch = source.indexOf("/app.js?v=${VERSION}");
  assert.ok(crowdImport >= 0);
  assert.ok(appLaunch > crowdImport);
});
