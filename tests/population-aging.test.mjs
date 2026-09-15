import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPopulationAging,
  naturalLifespanTicks,
  POPULATION_ELDER_AGE_TICKS,
  POPULATION_MAX_LIFESPAN_TICKS,
  POPULATION_MIN_LIFESPAN_TICKS,
} from "../dist-ts/src/demography.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("lineage-born adults become elders without canceling existing gestation", () => {
  const state = createInitialWorld({ seed: 3901 });
  const agent = state.agents[0];
  assert.ok(agent);
  agent.birthTick = 0;
  agent.lifeStage = "adult";
  const pregnancy = { partnerId: "partner", conceivedAtTick: 1, dueAtTick: POPULATION_ELDER_AGE_TICKS + 1 };
  agent.pregnancy = { ...pregnancy };
  state.tick = POPULATION_ELDER_AGE_TICKS;

  applyPopulationAging(state);

  const elder = state.agents.find((entry) => entry.id === agent.id);
  assert.ok(elder);
  assert.equal(elder.lifeStage, "elder");
  assert.deepEqual(elder.pregnancy, pregnancy);
  assert.match(elder.status, /^elder;/);
});

test("natural lifespan is deterministic, bounded, and removes only when reached", () => {
  const state = createInitialWorld({ seed: 3902 });
  const agent = state.agents[0];
  assert.ok(agent);
  agent.birthTick = 0;
  agent.lifeStage = "adult";
  const lifespan = naturalLifespanTicks(agent.id);
  assert.equal(naturalLifespanTicks(agent.id), lifespan);
  assert.ok(lifespan >= POPULATION_MIN_LIFESPAN_TICKS);
  assert.ok(lifespan <= POPULATION_MAX_LIFESPAN_TICKS);

  state.tick = lifespan - 1;
  applyPopulationAging(state);
  assert.equal(state.agents.some((entry) => entry.id === agent.id), true);

  state.tick = lifespan;
  applyPopulationAging(state);
  assert.equal(state.agents.some((entry) => entry.id === agent.id), false);
});

test("legacy founders without birth dates are not assigned synthetic death ages", () => {
  const state = createInitialWorld({ seed: 3903 });
  const founder = state.agents[0];
  assert.ok(founder);
  delete founder.birthTick;
  delete founder.lifeStage;
  state.tick = POPULATION_MAX_LIFESPAN_TICKS * 100;

  applyPopulationAging(state);

  assert.equal(state.agents.some((entry) => entry.id === founder.id), true);
});
