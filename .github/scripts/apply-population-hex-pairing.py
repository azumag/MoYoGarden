from pathlib import Path
import sys

runtime_path = Path("src/runtime.ts")
test_path = Path("tests/population-relationship-gate.test.mjs")

TEST = r'''import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("conception requires an established social relationship instead of proximity alone", () => {
  const state = createInitialWorld({ seed: 26091801 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  const position = { x: 19, y: 11 };
  const parent = structuredClone(templates[0]);
  const partner = structuredClone(templates[1]);
  assert.ok(parent);
  assert.ok(partner);

  parent.id = "relationship-parent";
  parent.name = "Relationship Parent";
  parent.position = { ...position };
  parent.hp = 100;
  parent.energy = 100;
  parent.autonomy = false;
  parent.lifeStage = "adult";
  parent.reproductiveRole = "gestational";
  delete parent.birthTick;
  delete parent.parents;
  delete parent.pregnancy;
  delete parent.lastBirthTick;
  delete parent.socialMemory;
  delete parent.task;

  partner.id = "relationship-partner";
  partner.name = "Relationship Partner";
  partner.position = { ...position };
  partner.hp = 100;
  partner.energy = 100;
  partner.autonomy = false;
  partner.lifeStage = "adult";
  partner.reproductiveRole = "partner";
  delete partner.birthTick;
  delete partner.parents;
  delete partner.pregnancy;
  delete partner.lastBirthTick;
  delete partner.socialMemory;
  delete partner.task;

  state.agents = [parent, partner];
  state.events = [];
  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "relationship-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;

  // At the first reproduction boundary these healthy adults are co-located but
  // have never interacted. Demography runs before social interactions, so mere
  // proximity must not create a pregnancy; the same tick then gives them a real
  // conversation and reciprocal social memory.
  state.tick = 8_639;
  const first = new WorldRuntime({ state }).tick().state;
  const firstParent = first.agents.find((agent) => agent.id === parent.id);
  const firstPartner = first.agents.find((agent) => agent.id === partner.id);
  assert.ok(firstParent);
  assert.ok(firstPartner);
  assert.equal(firstParent.pregnancy, undefined);
  assert.ok(firstParent.socialMemory?.some((entry) => entry.agentId === partner.id && entry.familiarity > 0));
  assert.ok(firstPartner.socialMemory?.some((entry) => entry.agentId === parent.id && entry.familiarity > 0));

  // Once the low-level relationship exists, the next reproduction boundary can
  // use it. No scripted couple or top-down family event is introduced.
  first.tick = 17_279;
  const second = new WorldRuntime({ state: first }).tick().state;
  const secondParent = second.agents.find((agent) => agent.id === parent.id);
  assert.ok(secondParent);
  assert.equal(secondParent.pregnancy?.partnerId, partner.id);
  assert.equal(secondParent.pregnancy?.conceivedAtTick, 17_280);
});
'''


def write_test() -> None:
    if test_path.exists():
        raise SystemExit(f"{test_path} already exists")
    test_path.write_text(TEST)


def apply_fix() -> None:
    text = runtime_path.read_text()
    old = '''        .map((candidate) => ({
          candidate,
          familiarity: pairFamiliarity(state, parent, candidate),
          distance: manhattanDistance(candidate.position, parent.position),
        }))
        .sort((a, b) =>
'''
    new = '''        .map((candidate) => ({
          candidate,
          familiarity: pairFamiliarity(state, parent, candidate),
          distance: manhattanDistance(candidate.position, parent.position),
        }))
        // Proximity is necessary but no longer sufficient for conception. A
        // pair must have at least one persisted social interaction first; the
        // ordinary conversation loop creates reciprocal socialMemory, while
        // retained conversation events remain a compatibility fallback for
        // saves that predate socialMemory.
        .filter(({ familiarity }) => familiarity > 0)
        .sort((a, b) =>
'''
    if text.count(old) != 1:
        raise SystemExit("expected exactly one conception candidate ranking anchor")
    runtime_path.write_text(text.replace(old, new, 1))


if len(sys.argv) != 2 or sys.argv[1] not in {"test", "fix"}:
    raise SystemExit("usage: apply-population-hex-pairing.py test|fix")
if sys.argv[1] == "test":
    write_test()
else:
    apply_fix()
