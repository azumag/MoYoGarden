import test from "node:test";
import assert from "node:assert/strict";

import {
  ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS,
  ARRIVAL_REGISTRATION_RETRY_TIMEOUT_MS,
  arrivalRegistrationRetryAlarmTarget,
  withArrivalRegistrationDeadline,
} from "../dist-ts/src/arrival-registration-reliability-entry.js";

const NOW = 1_000_000;

test("arrival registration failures request a bounded retry alarm without delaying an earlier alarm", () => {
  assert.equal(
    arrivalRegistrationRetryAlarmTarget(null, NOW),
    NOW + ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS,
  );
  assert.equal(
    arrivalRegistrationRetryAlarmTarget(NOW + 5_000, NOW),
    undefined,
  );
  assert.equal(
    arrivalRegistrationRetryAlarmTarget(NOW + ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS + 1, NOW),
    NOW + ARRIVAL_REGISTRATION_RETRY_ALARM_INTERVAL_MS,
  );
});

test("arrival registration retry deadline aborts a stalled cross-DO fetch", async () => {
  let observedAbort = false;
  await assert.rejects(
    withArrivalRegistrationDeadline((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    }), 20),
    /arrival claim registration exceeded 20ms/,
  );
  assert.equal(observedAbort, true);
});

test("arrival registration retry deadline is transparent for a timely response", async () => {
  const result = await withArrivalRegistrationDeadline(async (signal) => {
    assert.equal(signal.aborted, false);
    return "ok";
  }, ARRIVAL_REGISTRATION_RETRY_TIMEOUT_MS);
  assert.equal(result, "ok");
});
