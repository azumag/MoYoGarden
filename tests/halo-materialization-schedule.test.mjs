import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldMaterializeHaloForRegrowth,
  shouldMaterializeHaloForTick,
} from "../dist-ts/src/halo-region.js";

test("scheduled alarms fetch halo edges only for ticks that can apply regrowth compensation", () => {
  for (const tick of [0, 1, 27, 30, 58, 60, 120]) {
    assert.equal(
      shouldMaterializeHaloForTick(tick),
      false,
      `tick ${tick} should not trigger halo materialization`,
    );
  }

  for (const tick of [29, 59, 89, 119, 1199]) {
    assert.equal(
      shouldMaterializeHaloForTick(tick),
      true,
      `tick ${tick} should prefetch halo for the next regrowth tick`,
    );
  }
});

test("halo regrowth prefetch skips worlds with no depleted organic resource", () => {
  const state = {
    tiles: [
      { x: 1, y: 1, terrain: "plain" },
      { x: 2, y: 1, terrain: "plain", resource: { kind: "stone", amount: 0, maxAmount: 10 } },
      { x: 3, y: 1, terrain: "forest", resource: { kind: "wood", amount: 10, maxAmount: 10 } },
      { x: 4, y: 1, terrain: "plain", resource: { kind: "food", amount: 8, maxAmount: 8 } },
    ],
  };

  assert.equal(shouldMaterializeHaloForRegrowth(state, 29), false);
  state.tiles[2].resource.amount = 9;
  assert.equal(shouldMaterializeHaloForRegrowth(state, 29), true, "depleted wood can receive halo compensation");
  assert.equal(shouldMaterializeHaloForRegrowth(state, 30), false, "non-regrowth ticks still skip halo reads");
});
