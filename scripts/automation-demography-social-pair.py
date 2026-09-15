from pathlib import Path
import re
import textwrap

runtime_path = Path("src/runtime.ts")
runtime = runtime_path.read_text()

helper_pattern = re.compile(
    r"(function isAdultForReproduction\(agent: Agent, tick: number\): boolean \{.*?\n\}\n\n)(?=function applyLifeStageTransitions)",
    re.S,
)
helpers = textwrap.dedent(
    '''
    function areCloseReproductiveKin(first: Agent, second: Agent): boolean {
      const firstParents: readonly string[] = first.parents ?? [];
      const secondParents: readonly string[] = second.parents ?? [];
      if (firstParents.includes(second.id) || secondParents.includes(first.id)) return true;
      return firstParents.some((parentId) => secondParents.includes(parentId));
    }

    function pairConversationCount(state: WorldState, firstId: string, secondId: string): number {
      let count = 0;
      for (const event of state.events) {
        if (event.kind !== "agent_conversation" || event.tick > state.tick) continue;
        const targetAgentId = event.data?.targetAgentId;
        if (
          (event.agentId === firstId && targetAgentId === secondId) ||
          (event.agentId === secondId && targetAgentId === firstId)
        ) {
          count += 1;
        }
      }
      return count;
    }

    '''
).lstrip()
runtime, helper_count = helper_pattern.subn(lambda match: match.group(1) + helpers, runtime, count=1)
if helper_count != 1:
    raise SystemExit("reproduction helper anchor changed; refusing to patch")

partner_pattern = re.compile(
    r"      const partner = healthyAdults\n.*?      if \(partner === undefined\) continue;",
    re.S,
)
partner_replacement = '''      const partner = healthyAdults
        .filter((candidate) =>
          candidate.id !== parent.id &&
          reproductiveRole(candidate) === "partner" &&
          !areCloseReproductiveKin(parent, candidate) &&
          manhattanDistance(candidate.position, parent.position) <= POPULATION_PARENT_RADIUS
        )
        .map((candidate) => ({
          candidate,
          familiarity: pairConversationCount(state, parent.id, candidate.id),
          distance: manhattanDistance(candidate.position, parent.position),
        }))
        .sort((a, b) =>
          b.familiarity - a.familiarity ||
          a.distance - b.distance ||
          a.candidate.id.localeCompare(b.candidate.id)
        )[0]?.candidate;
      if (partner === undefined) continue;'''
runtime, partner_count = partner_pattern.subn(partner_replacement, runtime, count=1)
if partner_count != 1:
    raise SystemExit("partner selection anchor changed; refusing to patch")
runtime_path.write_text(runtime)

test_path = Path("tests/population-pairing-social.test.mjs")
if test_path.exists():
    raise SystemExit("pairing regression test already exists; refusing to overwrite")
test_path.write_text(
    textwrap.dedent(
        r'''
        import assert from "node:assert/strict";
        import test from "node:test";
        import { WorldRuntime } from "../dist-ts/src/runtime.js";
        import { createInitialWorld } from "../dist-ts/src/world.js";

        test("conception avoids close kin and prefers recent social familiarity", () => {
          const state = createInitialWorld({ seed: 26091601 });
          const faction = state.factions.find((entry) => entry.id === "ember");
          assert.ok(faction);
          const templates = state.agents.filter((agent) => agent.factionId === faction.id);
          assert.ok(templates.length >= 2);
          for (const tile of state.tiles) {
            if (tile.terrain === "water") tile.terrain = "plain";
          }

          const position = {
            x: Math.max(1, Math.min(state.width - 2, templates[0].position.x)),
            y: Math.max(1, Math.min(state.height - 2, templates[0].position.y)),
          };
          state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
          let templateIndex = 0;
          const makeMember = (id, name, reproductiveRole, memberPosition) => {
            const agent = structuredClone(templates[templateIndex % templates.length]);
            templateIndex += 1;
            assert.ok(agent);
            agent.id = id;
            agent.name = name;
            agent.position = memberPosition;
            agent.hp = 100;
            agent.energy = 100;
            agent.autonomy = false;
            agent.reproductiveRole = reproductiveRole;
            delete agent.pregnancy;
            delete agent.lastBirthTick;
            delete agent.parents;
            delete agent.task;
            return agent;
          };

          const parent = makeMember("pair-parent", "Pair Parent", "gestational", { ...position });
          parent.parents = ["founder-a", "founder-b"];
          const sibling = makeMember("pair-sibling", "Pair Sibling", "partner", { ...position });
          sibling.parents = ["founder-a", "founder-b"];
          const near = makeMember("pair-near", "Pair Near", "partner", { ...position });
          const familiar = makeMember(
            "pair-familiar",
            "Pair Familiar",
            "partner",
            { x: position.x + 1, y: position.y },
          );
          state.agents.push(parent, sibling, near, familiar);

          state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
          state.structures.push({
            id: "pairing-camp",
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

          for (let index = 0; index < 3; index += 1) {
            state.events.push({
              id: `kin-conversation-${index}`,
              tick: 8_600 + index,
              kind: "agent_conversation",
              message: "kin talk",
              agentId: parent.id,
              factionId: faction.id,
              position: { ...position },
              data: { targetAgentId: sibling.id },
            });
          }
          for (let index = 0; index < 2; index += 1) {
            state.events.push({
              id: `familiar-conversation-${index}`,
              tick: 8_610 + index,
              kind: "agent_conversation",
              message: "familiar talk",
              agentId: parent.id,
              factionId: faction.id,
              position: { ...position },
              data: { targetAgentId: familiar.id },
            });
          }

          const next = new WorldRuntime({ state }).tick().state;
          const conceived = next.agents.find((agent) => agent.id === parent.id);
          assert.ok(conceived);
          assert.equal(conceived.pregnancy?.partnerId, familiar.id);
          assert.notEqual(conceived.pregnancy?.partnerId, sibling.id);
          assert.notEqual(conceived.pregnancy?.partnerId, near.id);
        });
        '''
    ).lstrip()
)
