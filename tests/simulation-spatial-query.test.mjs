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

// Captured from unmodified main 71b818788e554d7231485f44a9c9575a2652f139.
// Stay below the 120-tick erosion boundary to isolate the routing optimization
// from the separately intentional current-vegetation erosion change.
test("spatial routing preserves full seeded simulation state and PRNG progression", () => {
  for (const [seed, expectedHash, expectedRng] of [
    [123456, "4cb5c3b89129e78162837d2590c840290074a877cb965b4b029274913985edca", 3370508769],
    [271828, "5d40227f816e1bde2da321353b76a6d83b9832346926cc6779d197f797cd4d94", 1241391839],
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
  assert.equal(fingerprint(next), "c8dbcd2b4045dbcee8b1e3df8ee28a9ecbef349c0ffcfa4150f94fd7e3308335");
  assert.equal(next.rngState, 3536807351);
  // The existing hex migration reads each position twice before movement;
  // routing should add only one population pass and a few mover-only reads.
  assert.ok(measuredReads <= state.agents.length * 3 + 16, `${measuredReads} position reads`);
  assert.ok(measuredReads < legacyReads / 10, "route must avoid repeated whole-population scans");
  context.diagnostic(`800 BOTs: ${legacyReads} legacy position reads -> ${measuredReads} indexed reads`);
});
