import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  pathogenStateIsQuiescent,
} from "../dist-ts/src/pathogen.js";
import { positionKey } from "../dist-ts/src/protocol.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function cleanState(seed) {
  const state = createInitialWorld({ seed, width: 40, height: 24 });
  for (const agent of state.agents) {
    delete agent.pathogenLoad;
    delete agent.pathogenImmunity;
  }
  for (const tile of state.tiles) delete tile.pathogenReservoir;
  return state;
}

test("quiescent pathogen state skips local work without blocking halo introduction", () => {
  const state = cleanState(260919);
  assert.equal(pathogenStateIsQuiescent(state), true);

  const before = structuredClone(state);
  assert.equal(applyPathogenSteps(state, 1), 0);
  assert.deepEqual(state, before, "a clean local pathogen step should be a true no-op");

  const target = state.agents[0];
  assert.ok(target);
  const halo = new Map([[positionKey(target.position), 1]]);
  assert.ok(applyPathogenSteps(state, 1, undefined, halo, 1) > 0);
  assert.ok(agentPathogenLoad(target) > 0, "halo exposure must still seed a clean region");
});

test("quiescent detection ignores compatibility cells but preserves cleanup of active optional state", () => {
  const state = cleanState(260920);
  const hidden = state.tiles.find((tile) => !isHexGridCell(state, tile));
  const active = state.tiles.find((tile) => isHexGridCell(state, tile));
  const target = state.agents[0];
  assert.ok(hidden);
  assert.ok(active);
  assert.ok(target);

  hidden.pathogenReservoir = 0.7;
  assert.equal(
    pathogenStateIsQuiescent(state),
    true,
    "non-owned compatibility-envelope burden must not wake the pathogen hot path",
  );

  active.pathogenReservoir = 0;
  assert.equal(
    pathogenStateIsQuiescent(state),
    false,
    "an explicitly stored active reservoir gets one normal pass so it can be cleaned",
  );
  delete active.pathogenReservoir;

  target.pathogenLoad = 0;
  assert.equal(pathogenStateIsQuiescent(state), false);
  assert.ok(applyPathogenSteps(state, 1) > 0);
  assert.equal(target.pathogenLoad, undefined);
  assert.equal(pathogenStateIsQuiescent(state), true);
});
