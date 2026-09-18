from pathlib import Path
import sys

runtime_path = Path("src/runtime.ts")
test_path = Path("tests/population-hex-pairing.test.mjs")

TEST = r'''import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const RADIUS_TWO_DIRECTIONS = [
  { x: 2, y: 0, name: "E" },
  { x: 2, y: -2, name: "NE" },
  { x: 0, y: -2, name: "NW" },
  { x: -2, y: 0, name: "W" },
  { x: -2, y: 2, name: "SW" },
  { x: 0, y: 2, name: "SE" },
];

function conceptionState(delta) {
  const state = createInitialWorld({ seed: 2042 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }

  const center = { x: 19, y: 11 };
  const parent = structuredClone(templates[0]);
  const partner = structuredClone(templates[1]);
  assert.ok(parent);
  assert.ok(partner);

  parent.id = "hex-pair-parent";
  parent.name = "Hex Parent";
  parent.position = { ...center };
  parent.hp = 100;
  parent.energy = 100;
  parent.autonomy = false;
  parent.lifeStage = "adult";
  parent.reproductiveRole = "gestational";
  delete parent.birthTick;
  delete parent.parents;
  delete parent.pregnancy;
  delete parent.lastBirthTick;
  delete parent.task;

  partner.id = "hex-pair-partner";
  partner.name = "Hex Partner";
  partner.position = { x: center.x + delta.x, y: center.y + delta.y };
  partner.hp = 100;
  partner.energy = 100;
  partner.autonomy = false;
  partner.lifeStage = "adult";
  partner.reproductiveRole = "partner";
  delete partner.birthTick;
  delete partner.parents;
  delete partner.pregnancy;
  delete partner.lastBirthTick;
  delete partner.task;

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  state.agents.push(parent, partner);
  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "hex-pair-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...center },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 8_639;
  return state;
}

test("conception radius treats all six axial directions equally", () => {
  for (const delta of RADIUS_TWO_DIRECTIONS) {
    const next = new WorldRuntime({ state: conceptionState(delta) }).tick().state;
    const parent = next.agents.find((agent) => agent.id === "hex-pair-parent");
    assert.ok(parent, delta.name);
    assert.equal(
      parent.pregnancy?.partnerId,
      "hex-pair-partner",
      `${delta.name} at hex distance 2 should remain inside the reproductive radius`,
    );
  }
});

test("conception radius still excludes a partner three hexes away", () => {
  const next = new WorldRuntime({ state: conceptionState({ x: 3, y: -3 }) }).tick().state;
  const parent = next.agents.find((agent) => agent.id === "hex-pair-parent");
  assert.ok(parent);
  assert.equal(parent.pregnancy, undefined);
});
'''


def write_test() -> None:
    if test_path.exists():
        raise SystemExit(f"{test_path} already exists")
    test_path.write_text(TEST)


def apply_fix() -> None:
    text = runtime_path.read_text()
    old_filter = "          manhattanDistance(candidate.position, parent.position) <= POPULATION_PARENT_RADIUS\n"
    new_filter = "          hexGridDistance(candidate.position, parent.position) <= POPULATION_PARENT_RADIUS\n"
    old_rank = "          distance: manhattanDistance(candidate.position, parent.position),\n"
    new_rank = "          distance: hexGridDistance(candidate.position, parent.position),\n"
    if text.count(old_filter) != 1:
        raise SystemExit("expected exactly one reproductive radius Manhattan-distance anchor")
    if text.count(old_rank) != 1:
        raise SystemExit("expected exactly one reproductive ranking Manhattan-distance anchor")
    text = text.replace(old_filter, new_filter, 1).replace(old_rank, new_rank, 1)
    runtime_path.write_text(text)


if len(sys.argv) != 2 or sys.argv[1] not in {"test", "fix"}:
    raise SystemExit("usage: apply-population-hex-pairing.py test|fix")
if sys.argv[1] == "test":
    write_test()
else:
    apply_fix()
