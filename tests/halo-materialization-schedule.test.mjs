import assert from "node:assert/strict";
import test from "node:test";
import { shouldMaterializeHaloForTick } from "../dist-ts/src/halo-region.js";

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
