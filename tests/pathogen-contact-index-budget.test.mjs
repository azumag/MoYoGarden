import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/pathogen.ts", import.meta.url), "utf8");

test("pathogen contact index excludes epidemiologically inert source agents", () => {
  assert.match(
    source,
    /for \(const agent of agents\) \{\s+if \(agentPathogenPressure\(agent\) <= PATHOGEN_EPSILON\) continue;/,
  );
  assert.match(
    source,
    /const contactIndex = buildPathogenContactIndex\(previousState\.agents\);/,
    "targets should still be evaluated from the complete immutable pre-step population",
  );
});
