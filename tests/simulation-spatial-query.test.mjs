import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld, inBounds } from "../dist-ts/src/world.js";

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
};
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");

function plainFixture(seed = 24024) {
  const state = createInitialWorld({ seed, width: 40, height: 24 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    delete tile.bedrockElevation;
    delete tile.soilThickness;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }
  state.structures = [];
  state.events = [];
  state.processedCommandIds = [];
  return state;
}

function crowdedRouteFixture(population) {
  const state = plainFixture();
  const cells = state.tiles.filter((tile) => inBounds(state, tile));
  const template = state.agents[0];
  state.agents = Array.from({ length: population }, (_, index) => {
    const agent = structuredClone(template);
    agent.id = index === 0 ? "mover" : `watcher-${String(index).padStart(4, "0")}`;
    agent.name = agent.id;
    const cell = cells[index % cells.length];
    agent.position = index === 0 ? { x: 14, y: 15 } : { x: cell.x, y: cell.y };
    agent.autonomy = false;
    agent.energy = 100;
    delete agent.task;
    return agent;
  });
  state.agents[0].task = {
    type: "move", source: "external", issuedAtTick: 0, target: { x: 25, y: 6 },
  };
  return state;
}

// Updated for #26 Phase 2 + DSH review fixes (soil-stateful semantics, bitwise-stable consistent layers).
// Stay below the 120-tick erosion boundary to isolate the routing optimization
// from the separately intentional current-vegetation erosion change.
test("spatial routing preserves full seeded simulation state and PRNG progression", () => {
  for (const [seed, expectedHash, expectedRng] of [
    [123456, "af78747a714b393bc923b438376319d17eeedb95276b915beb600588fc4396cb", 3370508769],
    [271828, "d2f83621f6bcac356212dc770640343fa7feb3e091533aa9d3dde67690d5df9e", 1241391839],
  ]) {
    let state = createInitialWorld({ seed, width: 40, height: 24 });
    for (let tick = 0; tick < 90; tick += 1) state = simulate(state).state;
    assert.equal(fingerprint(state), expectedHash);
    assert.equal(state.rngState, expectedRng);
  }
});

test("each route query sees earlier BOT moves in the same tick", () => {
  const initial = plainFixture();
  const template = initial.agents[0];
  initial.agents = ["a-leader", "b-follower"].map((id, index) => ({
    ...structuredClone(template),
    id,
    name: id,
    position: { x: 19, y: 11 },
    autonomy: false,
    task: {
      type: "move", source: "external", issuedAtTick: 0,
      target: index === 0 ? { x: 20, y: 11 } : { x: 21, y: 10 },
    },
  }));
  for (const reversed of [false, true]) {
    const state = structuredClone(initial);
    if (reversed) state.agents.reverse();
    const next = simulate(state).state;
    assert.deepEqual(next.agents.find((agent) => agent.id === "a-leader").position, { x: 20, y: 11 });
    // The leader has just occupied the initially empty east route. A snapshot
    // taken once for the whole tick would incorrectly send the follower there.
    assert.deepEqual(next.agents.find((agent) => agent.id === "b-follower").position, { x: 20, y: 10 });
  }
});

test("800-BOT route matches legacy output with one population scan", (context) => {
  const state = crowdedRouteFixture(800);
  let positionReads = 0;
  const originalClone = globalThis.structuredClone;
  // Instrument only the cloned working state. No production hooks or timing
  // thresholds are needed, and the persisted input remains ordinary plain data.
  const cloneMock = context.mock.method(globalThis, "structuredClone", (...args) => {
    const copy = originalClone(...args);
    for (const agent of copy.agents) {
      let position = agent.position;
      Object.defineProperty(agent, "position", {
        configurable: true,
        enumerable: true,
        get() { positionReads += 1; return position; },
        set(value) { position = value; },
      });
    }
    return copy;
  });
  let next;
  try {
    next = simulate(state).state;
  } finally {
    cloneMock.mock.restore();
  }
  const measuredReads = positionReads;
  const legacyReads = 24803;
  assert.equal(fingerprint(next), "dfa218def4f84e51f6a90c26596fe8a037c5ab1bcb5c35d3af69381c765651cf");
  assert.equal(next.rngState, 3536807351);
  // The existing hex migration reads each position twice before movement;
  // routing should add only one population pass and a few mover-only reads.
  assert.ok(measuredReads <= state.agents.length * 3 + 16, `${measuredReads} position reads`);
  assert.ok(measuredReads < legacyReads / 10, "route must avoid repeated whole-population scans");
  context.diagnostic(`800 BOTs: ${legacyReads} legacy position reads -> ${measuredReads} indexed reads`);
});
