import assert from "node:assert/strict";
import test from "node:test";
import {
  PATHOGEN_EDGE_READ_TIMEOUT_MS,
  withPathogenEdgeDeadline,
} from "../dist-ts/src/pathogen-region.js";

test("pathogen edge deadline returns fast successful reads unchanged", async () => {
  const value = await withPathogenEdgeDeadline(async (signal) => {
    assert.equal(signal.aborted, false);
    return "ok";
  }, 50);
  assert.equal(value, "ok");
  assert.equal(PATHOGEN_EDGE_READ_TIMEOUT_MS, 5_000);
});

test("pathogen edge deadline aborts and rejects a stalled neighbor read", async () => {
  let observedAbort = false;
  const startedAt = Date.now();
  await assert.rejects(
    withPathogenEdgeDeadline(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      }),
      10,
    ),
    (error) => error instanceof Error && error.name === "TimeoutError",
  );
  assert.equal(observedAbort, true, "the in-flight neighbor request should receive cancellation");
  assert.ok(Date.now() - startedAt < 1_000, "the deadline must release the caller promptly");
});
