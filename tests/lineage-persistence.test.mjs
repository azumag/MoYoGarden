import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGrandparentList,
  LINEAGE_GRANDPARENT_LIMIT,
  newbornAgentLineage,
  normalizedAgentLineage,
} from "../dist-ts/src/lineage.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const REGION_ID = "garden-1";

function familyWorld() {
  const state = createInitialWorld({ seed: 6041, regionId: REGION_ID });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);
  const position = { ...templates[0].position };

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  const makeMember = (id, name, reproductiveRole) => {
    const agent = structuredClone(templates[0]);
    agent.id = id;
    agent.name = name;
    agent.position = { ...position };
    agent.hp = 100;
    agent.energy = 100;
    agent.autonomy = false;
    agent.reproductiveRole = reproductiveRole;
    delete agent.pregnancy;
    delete agent.lastBirthTick;
    delete agent.parents;
    delete agent.lineage;
    delete agent.task;
    return agent;
  };

  const parent = makeMember("lineage-parent", "Lineage Parent", "gestational");
  const partner = makeMember("lineage-partner", "Lineage Partner", "partner");
  parent.socialMemory = [{ agentId: partner.id, familiarity: 4, lastInteractionTick: 1 }];
  partner.socialMemory = [{ agentId: parent.id, familiarity: 4, lastInteractionTick: 1 }];
  state.agents.push(parent, partner);

  state.structures = state.structures.filter((entry) => entry.factionId !== faction.id);
  state.structures.push({
    id: "lineage-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 8_639;
  return { state, faction, parent, partner };
}

function conceive(state) {
  const conceived = new WorldRuntime({ state }).tick().state;
  const gestational = conceived.agents.find((agent) => agent.pregnancy !== undefined);
  assert.ok(gestational?.pregnancy, "expected a conception on the reproduction tick");
  return { conceived, gestational };
}

function birth(conceived, gestational) {
  conceived.tick = gestational.pregnancy.dueAtTick - 1;
  const born = new WorldRuntime({ state: conceived }).tick().state;
  const newborn = born.agents.find(
    (agent) => agent.birthTick === born.tick && agent.parents?.[0] === gestational.id,
  );
  assert.ok(newborn, "expected a birth on the due tick");
  return { born, newborn };
}

function stripLineageFields(state) {
  for (const agent of state.agents) {
    delete agent.lineage;
    if (agent.pregnancy !== undefined) {
      delete agent.pregnancy.partnerGeneration;
      delete agent.pregnancy.partnerParents;
    }
  }
  return state;
}

test("conception snapshots partner lineage and birth fixes canonical grandparents (R1)", () => {
  const { state, parent, partner } = familyWorld();
  // Mixed surface forms on the gestational side and a still-local partner side
  // cover the common case where the ancestors never crossed a region boundary.
  parent.lineage = { generation: 2, grandparents: ["agent-global:garden-9:gg-1"] };
  parent.parents = ["agent-global:garden-9:gp-a", "gp-b"];
  partner.lineage = { generation: 3, grandparents: [] };
  partner.parents = ["gp-c", "gp-d"];

  const { conceived, gestational } = conceive(state);
  assert.equal(gestational.pregnancy.partnerGeneration, 3);
  assert.deepEqual(gestational.pregnancy.partnerParents, ["gp-c", "gp-d"]);

  const { newborn } = birth(conceived, gestational);
  assert.deepEqual(newborn.parents, [parent.id, partner.id]);
  assert.equal(newborn.lineage?.generation, 4);
  assert.deepEqual(newborn.lineage?.grandparents, [
    `agent-global:${REGION_ID}:gp-b`,
    `agent-global:${REGION_ID}:gp-c`,
    `agent-global:${REGION_ID}:gp-d`,
    "agent-global:garden-9:gp-a",
  ]);
});

test("newbornAgentLineage canonicalizes both sides before union, dedupe and sort", () => {
  const lineage = newbornAgentLineage(
    REGION_ID,
    { parents: ["gp-z", "agent-global:garden-9:gp-x"] },
    { partnerGeneration: 0, partnerParents: ["gp-a", "gp-z"] },
    undefined,
  );
  assert.equal(lineage.generation, 1);
  // gp-z arrives on both sides in different surface forms and is deduplicated
  // after canonicalization, then the whole list is sorted ascending.
  assert.deepEqual(lineage.grandparents, [
    `agent-global:${REGION_ID}:gp-a`,
    `agent-global:${REGION_ID}:gp-z`,
    "agent-global:garden-9:gp-x",
  ]);
});

test("grandparent record stays bounded at LINEAGE_GRANDPARENT_LIMIT", () => {
  assert.equal(LINEAGE_GRANDPARENT_LIMIT, 4);
  const list = canonicalGrandparentList(REGION_ID, [
    "gp-e", "gp-d", "gp-c", "gp-b", "gp-a", "gp-e",
  ]);
  assert.equal(list.length, LINEAGE_GRANDPARENT_LIMIT);
  assert.deepEqual(
    list,
    [...list].sort((a, b) => a.localeCompare(b)),
    "grandparents stay sorted after truncation",
  );
});

test("partner death before birth keeps generation and grandparents via snapshot", () => {
  const { state, partner } = familyWorld();
  partner.lineage = { generation: 5, grandparents: [] };
  partner.parents = ["gp-c", "gp-d"];

  const { conceived, gestational } = conceive(state);
  conceived.agents = conceived.agents.filter((agent) => agent.id !== partner.id);

  const { born, newborn } = birth(conceived, gestational);
  assert.equal(born.agents.some((agent) => agent.id === partner.id), false);
  assert.equal(newborn.lineage?.generation, 6);
  assert.deepEqual(newborn.lineage?.grandparents, [
    `agent-global:${REGION_ID}:gp-c`,
    `agent-global:${REGION_ID}:gp-d`,
  ]);
});

test("founders and legacy residents read as empty lineage; child is generation 1", () => {
  const { state } = familyWorld();
  const { conceived, gestational } = conceive(state);
  const { newborn } = birth(conceived, gestational);
  assert.deepEqual(newborn.lineage, { generation: 1, grandparents: [] });
  assert.deepEqual(normalizedAgentLineage(undefined), { generation: 0, grandparents: [] });
  assert.deepEqual(normalizedAgentLineage({}), { generation: 0, grandparents: [] });
});

test("pregnancy persisted before snapshots falls back to the living partner", () => {
  const { state, parent, partner } = familyWorld();
  partner.lineage = { generation: 4, grandparents: [] };
  partner.parents = ["gp-c"];
  // A pregnancy written before lineage snapshots existed carries none of the
  // new fields; the living partner's current values backfill them at birth.
  parent.pregnancy = {
    partnerId: partner.id,
    conceivedAtTick: 8_000,
    dueAtTick: 8_640,
  };

  const born = new WorldRuntime({ state }).tick().state;
  const newborn = born.agents.find(
    (agent) => agent.birthTick === born.tick && agent.parents?.[0] === parent.id,
  );
  assert.ok(newborn);
  assert.equal(newborn.lineage?.generation, 5);
  assert.deepEqual(newborn.lineage?.grandparents, [`agent-global:${REGION_ID}:gp-c`]);
});

test("lineage fields are write-only: adversarial seeds cannot change outcomes (R2)", () => {
  const { state } = familyWorld();
  const seeded = () => {
    const copy = structuredClone(state);
    for (const agent of copy.agents) {
      agent.lineage = { generation: 99, grandparents: ["agent-global:ghost:bogus"] };
    }
    return copy;
  };
  const runScenario = (input) => {
    const { conceived, gestational } = conceive(input);
    return birth(conceived, gestational).born;
  };

  const adversarial = runScenario(seeded());
  const baseline = runScenario(structuredClone(state));
  const repeat = runScenario(seeded());

  // The seeded values really flowed through (snapshot + derived generation),
  // so the stripped comparison is a meaningful same-seed equivalence check.
  assert.ok(adversarial.agents.some((agent) => (agent.lineage?.generation ?? 0) >= 99));
  assert.ok(baseline.agents.every((agent) => (agent.lineage?.generation ?? 0) <= 1));

  assert.deepEqual(
    stripLineageFields(structuredClone(adversarial)),
    stripLineageFields(structuredClone(baseline)),
    "births, pairing and population are identical once lineage fields are removed",
  );
  assert.deepEqual(repeat, adversarial, "same seed produces identical states twice");
});

test("serialized lineage overhead stays bounded per recorded agent", () => {
  const { state, parent, partner } = familyWorld();
  parent.lineage = { generation: 1, grandparents: ["agent-global:garden-9:gg-1"] };
  parent.parents = ["gp-a", "gp-b"];
  partner.lineage = { generation: 1, grandparents: [] };
  partner.parents = ["gp-c", "gp-d"];

  const { conceived, gestational } = conceive(state);
  const { born } = birth(conceived, gestational);

  const full = JSON.stringify(born).length;
  const stripped = JSON.stringify(stripLineageFields(structuredClone(born))).length;
  const recorded = born.agents.filter((agent) => agent.lineage !== undefined).length;
  assert.ok(recorded >= 3, "both parents and the newborn carry lineage records");
  const perAgent = (full - stripped) / recorded;
  console.log(
    `[lineage-size] full=${full}B stripped=${stripped}B ` +
    `delta=${full - stripped}B recorded=${recorded} perAgent=${perAgent.toFixed(1)}B`,
  );
  assert.ok(
    perAgent < 512,
    `lineage fields should stay well under a few hundred bytes per agent, got ${perAgent.toFixed(1)}B`,
  );
});
