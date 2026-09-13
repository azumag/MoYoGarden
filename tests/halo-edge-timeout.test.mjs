import assert from "node:assert/strict";
import test from "node:test";
import {
  HALO_EDGE_READ_TIMEOUT_MS,
  readHaloEdgeJsonWithDeadline,
  withHaloEdgeDeadline,
} from "../dist-ts/src/halo-region.js";

test("halo edge deadline returns fast successful reads unchanged", async () => {
  const value = await withHaloEdgeDeadline(async (signal) => {
    assert.equal(signal.aborted, false);
    return "ok";
  }, 50);
  assert.equal(value, "ok");
  assert.equal(HALO_EDGE_READ_TIMEOUT_MS, 5_000);
});

test("halo edge deadline aborts and rejects a stalled neighbor read", async () => {
  let observedAbort = false;
  const startedAt = Date.now();
  await assert.rejects(
    withHaloEdgeDeadline(
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
  assert.equal(observedAbort, true, "the in-flight halo request should receive cancellation");
  assert.ok(Date.now() - startedAt < 1_000, "the deadline must release the caller promptly");
});

test("halo edge deadline also covers a stalled response body", async () => {
  let bodyStarted = false;
  let observedAbort = false;
  const startedAt = Date.now();

  await assert.rejects(
    readHaloEdgeJsonWithDeadline(
      async (signal) => ({
        ok: true,
        json: async () => {
          bodyStarted = true;
          return await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              observedAbort = true;
              reject(signal.reason);
            }, { once: true });
          });
        },
      }),
      10,
    ),
    (error) => error instanceof Error && error.name === "TimeoutError",
  );

  assert.equal(bodyStarted, true, "the fake response should reach body consumption");
  assert.equal(observedAbort, true, "the same deadline should cancel stalled body work");
  assert.ok(Date.now() - startedAt < 1_000, "stalled JSON parsing must not pin the caller");
});
