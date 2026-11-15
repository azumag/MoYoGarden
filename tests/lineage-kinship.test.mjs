import assert from "node:assert/strict";
import test from "node:test";
import { areCloseLineageKin } from "../dist-ts/src/lineage.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const REGION = "garden-1";
const globalId = (localId) => `agent-global:${REGION}:${localId}`;

test("detects parent-child in both directions and across surface forms", () => {
  const child = { id: "a-child", parents: ["a-mom", "a-dad"] };
  const mother = { id: "a-mom" };
  assert.equal(areCloseLineageKin(REGION, child, mother), true);
  assert.equal(areCloseLineageKin(REGION, mother, child), true);
  // A handoff-promoted parent still names the same physical agent.
  assert.equal(areCloseLineageKin(REGION, child, { id: globalId("a-mom") }), true);
});

test("detects full and half siblings, including mixed surface forms", () => {
  const first = { id: "s-1", parents: ["p-a", "p-b"] };
  assert.equal(
    areCloseLineageKin(REGION, first, { id: "s-2", parents: ["p-a", "p-b"] }),
    true,
    "full siblings",
  );
  assert.equal(
    areCloseLineageKin(REGION, first, { id: "s-3", parents: ["p-a", "p-x"] }),
    true,
    "half siblings sharing one parent",
  );
  assert.equal(
    areCloseLineageKin(REGION, first, { id: "s-4", parents: ["p-y", "p-z"] }),
    false,
    "different parents are not siblings",
  );
  // A sibling that handoffed and came back carries world-global parents while
  // the resident side still stores the source-local form: same people either
  // way, so the promotion cannot hide the relationship.
  const promoted = { id: "s-5", parents: [globalId("p-a"), globalId("p-x")] };
  assert.equal(areCloseLineageKin(REGION, first, promoted), true);
});

test("detects grandparent-grandchild in both directions", () => {
  const grandchild = {
    id: "gc",
    parents: ["par-a", "par-b"],
    lineage: { generation: 2, grandparents: [globalId("gp-1"), globalId("gp-2")] },
  };
  const grandparent = { id: globalId("gp-1") };
  assert.equal(areCloseLineageKin(REGION, grandchild, grandparent), true);
  assert.equal(areCloseLineageKin(REGION, grandparent, grandchild), true);
  // The grandparent side never stores grandchild references; the check only
  // ever reads the younger agent's bounded grandparent list.
  const stillLocal = {
    id: "gc-2",
    lineage: { generation: 2, grandparents: ["gp-1"] },
  };
  assert.equal(areCloseLineageKin(REGION, stillLocal, grandparent), true);
});

test("detects uncle/aunt-nephew/niece via parent-grandparent overlap", () => {
  // The aunt's parent is the nephew's grandparent.
  const aunt = { id: "aunt", parents: ["gp-1", "gp-2"] };
  const nephew = {
    id: "nephew",
    parents: ["par-x", "par-y"],
    lineage: { generation: 2, grandparents: [globalId("gp-1"), globalId("gp-3")] },
  };
  assert.equal(areCloseLineageKin(REGION, aunt, nephew), true);
  assert.equal(areCloseLineageKin(REGION, nephew, aunt), true);
  // A half uncle shares only one parent with the nephew's parent, which still
  // lands that shared parent in the nephew's grandparent list.
  const halfUncle = { id: "half-uncle", parents: ["gp-3", "gp-9"] };
  assert.equal(areCloseLineageKin(REGION, halfUncle, nephew), true);
});

test("detects first cousins including half cousins via shared grandparents", () => {
  const first = {
    id: "c-1",
    parents: ["pa", "pb"],
    lineage: {
      generation: 2,
      grandparents: [globalId("gg-1"), globalId("gg-2"), globalId("gg-3"), globalId("gg-4")],
    },
  };
  const fullCousin = {
    id: "c-2",
    lineage: { generation: 2, grandparents: [globalId("gg-1"), globalId("gg-2")] },
  };
  const halfCousin = {
    id: "c-3",
    lineage: { generation: 2, grandparents: [globalId("gg-4"), globalId("gg-9")] },
  };
  const unrelated = {
    id: "c-4",
    parents: ["px", "py"],
    lineage: { generation: 2, grandparents: [globalId("gg-7"), globalId("gg-8")] },
  };
  assert.equal(areCloseLineageKin(REGION, first, fullCousin), true);
  assert.equal(areCloseLineageKin(REGION, first, halfCousin), true);
  assert.equal(areCloseLineageKin(REGION, first, unrelated), false);
});

test("does not detect second cousins: shared great-grandparents are out of scope", () => {
  // Two second cousins share great-grandparents, which are never recorded.
  // Their parents, and each side's bounded grandparent list, stay disjoint.
  const first = {
    id: "sc-1",
    parents: ["pa-1", "pa-2"],
    lineage: {
      generation: 3,
      grandparents: [globalId("ga-1"), globalId("ga-2"), globalId("ga-3"), globalId("ga-4")],
    },
  };
  const second = {
    id: "sc-2",
    parents: ["pb-1", "pb-2"],
    lineage: {
      generation: 3,
      grandparents: [globalId("gb-1"), globalId("gb-2"), globalId("gb-3"), globalId("gb-4")],
    },
  };
  assert.equal(areCloseLineageKin(REGION, first, second), false);
});

test("founders and legacy residents without lineage or parents are not kin", () => {
  const founderA = { id: "f-a" };
  const founderB = { id: "f-b" };
  assert.equal(areCloseLineageKin(REGION, founderA, founderB), false);
  // A persisted lineage that predates the grandparents field normalizes empty.
  const partial = { id: "f-c", lineage: { generation: 3 } };
  assert.equal(areCloseLineageKin(REGION, founderA, partial), false);
  // The same physical agent under two surface forms is still close kin.
  assert.equal(areCloseLineageKin(REGION, founderA, { id: globalId("f-a") }), true);
});

function kinshipWorld() {
  const state = createInitialWorld({ seed: 7703, regionId: REGION });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);
  const position = { ...templates[0].position };

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  const makeMember = (id, reproductiveRole) => {
    const agent = structuredClone(templates[0]);
    agent.id = id;
    agent.name = id;
    agent.position = { ...position };
    agent.hp = 100;
    agent.energy = 100;
    agent.autonomy = false;
    agent.reproductiveRole = reproductiveRole;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
    delete agent.parents;
    delete agent.lineage;
    delete agent.socialMemory;
    delete agent.task;
    return agent;
  };
  const familiar = (agent, otherId, familiarity) => {
    agent.socialMemory = [{ agentId: otherId, familiarity, lastInteractionTick: 1 }];
  };

  state.structures = state.structures.filter((entry) => entry.factionId !== faction.id);
  state.structures.push({
    id: "kinship-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.events = [];
  state.tick = 8_639;
  return { state, faction, makeMember, familiar };
}

test("conception avoids a cousin and pairs with the unrelated familiar partner", () => {
  const { state, makeMember, familiar } = kinshipWorld();
  const parent = makeMember("kin-parent", "gestational");
  parent.lineage = { generation: 2, grandparents: [globalId("gp-1"), globalId("gp-2")] };
  const cousin = makeMember("kin-cousin", "partner");
  cousin.lineage = { generation: 2, grandparents: [globalId("gp-1"), globalId("gp-9")] };
  const unrelated = makeMember("kin-unrelated", "partner");
  state.agents.push(parent, cousin, unrelated);

  // The cousin is the stronger relationship on paper; the kin filter, not the
  // familiarity ordering, is what keeps this pair from conceiving.
  familiar(parent, cousin.id, 6);
  familiar(cousin, parent.id, 6);
  familiar(parent, unrelated.id, 4);
  familiar(unrelated, parent.id, 4);

  const next = new WorldRuntime({ state }).tick().state;
  const conceived = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(conceived);
  assert.equal(conceived.pregnancy?.partnerId, unrelated.id);
  assert.notEqual(conceived.pregnancy?.partnerId, cousin.id);
});

test("conception is skipped entirely when every nearby candidate is close kin", () => {
  const { state, makeMember, familiar } = kinshipWorld();
  const parent = makeMember("kin-parent", "gestational");
  parent.lineage = { generation: 2, grandparents: [globalId("gp-1")] };
  const cousin = makeMember("kin-cousin", "partner");
  cousin.lineage = { generation: 2, grandparents: [globalId("gp-1"), globalId("gp-9")] };
  state.agents.push(parent, cousin);
  familiar(parent, cousin.id, 6);
  familiar(cousin, parent.id, 6);

  const next = new WorldRuntime({ state }).tick().state;
  const resolved = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(resolved);
  assert.equal(resolved.pregnancy, undefined);
});

test("conception avoids a sibling whose parents were promoted by handoff", () => {
  const { state, makeMember, familiar } = kinshipWorld();
  const parent = makeMember("kin-parent", "gestational");
  parent.parents = ["founder-a", "founder-b"];
  const sibling = makeMember("kin-sibling", "partner");
  // The sibling's parents already crossed a region boundary, so the same two
  // founders are recorded in world-global form on this side only.
  sibling.parents = [globalId("founder-a"), globalId("founder-b")];
  const unrelated = makeMember("kin-unrelated", "partner");
  state.agents.push(parent, sibling, unrelated);
  familiar(parent, sibling.id, 6);
  familiar(sibling, parent.id, 6);
  familiar(parent, unrelated.id, 4);
  familiar(unrelated, parent.id, 4);

  const next = new WorldRuntime({ state }).tick().state;
  const conceived = next.agents.find((agent) => agent.id === parent.id);
  assert.ok(conceived);
  assert.equal(conceived.pregnancy?.partnerId, unrelated.id);
  assert.notEqual(conceived.pregnancy?.partnerId, sibling.id);
});
