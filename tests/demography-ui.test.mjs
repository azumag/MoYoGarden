import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { agentDemography, populationComposition } from "../public/client/demography-ui.js";

const founder = {
  id: "founder", name: "Founder", factionId: "f", role: "farmer",
  position: { x: 1, y: 1 }, hp: 100, energy: 100, capacity: 10,
  inventory: { wood: 0, stone: 0, food: 0 }, autonomy: true, goal: "", status: "idle",
};
const parent = {
  ...founder, id: "parent", name: "Parent", lifeStage: "adult", birthTick: 20,
  pregnancy: { partnerId: "founder", conceivedAtTick: 90, dueAtTick: 130 },
};
const child = {
  ...founder, id: "child", name: "Child", lifeStage: "juvenile", birthTick: 80,
  parents: ["parent", "founder"],
};
const elder = { ...founder, id: "elder", name: "Elder", lifeStage: "elder", birthTick: 0 };
const infant = { ...founder, id: "infant", name: "Infant", lifeStage: "infant", birthTick: 115 };
const state = { tick: 120, agents: [founder, parent, child, elder, infant] };

test("selected-agent demography exposes age, life stage, lineage, and pregnancy without breaking founders", () => {
  assert.deepEqual(agentDemography(founder, state), {
    age: "不明（既存個体）",
    lifeStage: "成人",
    parents: "—（創始個体）",
    pregnancy: "—",
  });
  assert.deepEqual(agentDemography(child, state), {
    age: "40 tick",
    lifeStage: "若年",
    parents: "Parent (parent) / Founder (founder)",
    pregnancy: "—",
  });
  assert.equal(agentDemography(parent, state).pregnancy, "妊娠中 · あと10 tick");
});

test("population composition treats schema-v1 founders as adults and reports pregnancy separately", () => {
  assert.equal(populationComposition(state), "乳児 1 · 若年 1 · 成人 2 · 高齢 1 · 妊娠 1");
});

test("browser DOM keeps demographic observability wired to stable ids", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["agent-age", "agent-life-stage", "agent-parents", "agent-pregnancy", "observation-population"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(app, new RegExp(`#${id}`));
  }
  assert.match(app, /agentDemography\(agent, state\)/);
  assert.match(app, /populationComposition\(state\)/);
});
