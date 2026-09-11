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
    width: 9,
    height: 9,
    tiles: [
      { x: 1, y: 1, terrain: "plain" },
      { x: 2, y: 1, terrain: "plain", resource: { kind: "stone", amount: 0, maxAmount: 10 } },
      { x: 3, y: 1, terrain: "forest", resource: { kind: "wood", amount: 10, maxAmount: 10 } },
      { x: 4, y: 1, terrain: "plain", resource: { kind: "food", amount: 8, maxAmount: 8 } },
    ],
  };

  assert.equal(shouldMaterializeHaloForRegrowth(state, 29), false);
  state.tiles[2].resource.amount = 9;
  assert.equal(shouldMaterializeHaloForRegrowth(state, 29), true, "depleted boundary wood can receive halo compensation");
  assert.equal(shouldMaterializeHaloForRegrowth(state, 30), false, "non-regrowth ticks still skip halo reads");
});

test("interior depleted resources do not wake neighboring regions for halo regrowth", () => {
  const state = {
    width: 40,
    height: 24,
    tiles: [
      { x: 19, y: 11, terrain: "forest", resource: { kind: "wood", amount: 9, maxAmount: 10 } },
    ],
  };

  assert.equal(
    shouldMaterializeHaloForRegrowth(state, 29),
    false,
    "the center is too far from any ghost cell for current halo signals to matter",
  );

  state.tiles[0].y = 4;
  assert.equal(
    shouldMaterializeHaloForRegrowth(state, 29),
    false,
    "boundary depth four is still one cell beyond the four-cell ghost-water radius",
  );

  state.tiles[0].y = 3;
  assert.equal(
    shouldMaterializeHaloForRegrowth(state, 29),
    true,
    "boundary depth three can still observe a ghost-water source four cells away",
  );
});
