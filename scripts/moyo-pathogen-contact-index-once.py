from pathlib import Path

path = Path("src/pathogen.ts")
text = path.read_text()
old_comment = ''' * Bucket the immutable pre-step population by logical hex. Pathogen contact is
 * local by definition (same cell or one of six neighbors), so scanning every BOT
 * for every target needlessly turns a contact step into O(N²) work as population
 * grows. The index keeps the exact same contact geometry while making the common
 * sparse case proportional to population plus the agents in seven nearby cells.
 */
'''
new_comment = ''' * Bucket infectious pre-step sources by logical hex. Pathogen contact is local
 * by definition (same cell or one of six neighbors), so scanning every BOT for
 * every target needlessly turns a contact step into O(N²) work as population
 * grows. Healthy, latent and dead agents contribute zero source pressure and are
 * therefore omitted from the source index; they still remain targets in the main
 * pathogen loop. This preserves contact geometry while keeping crowded healthy
 * settlements from paying per-target scans over epidemiologically inert agents.
 */
'''
assert text.count(old_comment) == 1
text = text.replace(old_comment, new_comment)
old_loop = '''  const mutable = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = positionKey(agent.position);
'''
new_loop = '''  const mutable = new Map<string, Agent[]>();
  for (const agent of agents) {
    if (agentPathogenPressure(agent) <= PATHOGEN_EPSILON) continue;
    const key = positionKey(agent.position);
'''
assert text.count(old_loop) == 1
text = text.replace(old_loop, new_loop)
path.write_text(text)

Path("tests/pathogen-contact-index-budget.test.mjs").write_text('''import assert from "node:assert/strict";
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
''')
