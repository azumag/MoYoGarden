from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"patch anchor missing in {path}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/simulation.ts",
    "const DEPOSIT_CROWDED_THROUGHPUT = 3;\n",
    "const DEPOSIT_CROWDED_THROUGHPUT = 3;\nconst AUTONOMOUS_REMOTE_TRADE_TTL = 72;\n",
)

replace_once(
    "src/simulation.ts",
    '''function executeTrade(state: WorldState, agent: Agent, task: Extract<AgentTask, { type: "trade" }>): void {\n  const target = getAgent(state, task.targetAgentId);\n  if (target === undefined) {\n    delete agent.task;\n    agent.status = "trade target disappeared";\n    return;\n  }\n''',
    '''function executeTrade(state: WorldState, agent: Agent, task: Extract<AgentTask, { type: "trade" }>): void {\n  const target = getAgent(state, task.targetAgentId);\n  if (target === undefined) {\n    if (\n      task.source === "autonomy"\n      && task.targetAgentId.startsWith("agent-global:")\n      && state.tick - task.issuedAtTick <= AUTONOMOUS_REMOTE_TRADE_TTL\n    ) {\n      // A counterparty can leave this Region DO between planning and execution.\n      // Keep the world-global promise alive long enough for the cross-region\n      // autonomy layer to discover its new owner instead of deleting it in the\n      // same tick as ownership handoff. The bounded virtual-tick TTL prevents a\n      // permanently vanished counterparty from pinning the trader forever.\n      agent.status = `locating trade counterparty ${task.targetAgentId}`;\n      return;\n    }\n    delete agent.task;\n    agent.status = task.source === "autonomy" && task.targetAgentId.startsWith("agent-global:")\n      ? "remote trade target lookup expired"\n      : "trade target disappeared";\n    return;\n  }\n''',
)

replace_once(
    "src/agent-ownership.ts",
    '''function rewriteResidentFamilyReference(\n  agent: Agent,\n  sourceLocalId: string,\n  promotedId: string,\n): void {\n''',
    '''function rewriteResidentFamilyReference(\n  agent: Agent,\n  sourceLocalId: string,\n  promotedId: string,\n  currentTick: number,\n): void {\n''',
)

replace_once(
    "src/agent-ownership.ts",
    '''    agent.task = { ...agent.task, targetAgentId: promotedId };\n''',
    '''    agent.task = {\n      ...agent.task,\n      targetAgentId: promotedId,\n      // Start a fresh bounded discovery window at the ownership change rather\n      // than inheriting however long the local trade was already in progress.\n      issuedAtTick: currentTick,\n    };\n''',
)

replace_once(
    "src/agent-ownership.ts",
    '''    rewriteResidentFamilyReference(resident, agent.id, promotedId);\n''',
    '''    rewriteResidentFamilyReference(resident, agent.id, promotedId, snapshot.state.tick);\n''',
)

replace_once(
    "tests/agent-ownership-trade-reference.test.mjs",
    '''  trader.task = {\n    source: "autonomy",\n    issuedAtTick: state.tick,\n''',
    '''  trader.task = {\n    source: "autonomy",\n    issuedAtTick: state.tick - 100,\n''',
)
replace_once(
    "tests/agent-ownership-trade-reference.test.mjs",
    '''  assert.equal(resident.task.issuedAtTick, originalTask.issuedAtTick);\n''',
    '''  assert.equal(\n    resident.task.issuedAtTick,\n    state.tick,\n    "promoting the counterparty should open a fresh bounded remote-discovery window",\n  );\n  assert.notEqual(resident.task.issuedAtTick, originalTask.issuedAtTick);\n''',
)

Path("tests/autonomous-remote-trade-retention.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function remoteTradeState() {
  const state = createInitialWorld({ seed: 9521, width: 40, height: 24, regionId: "garden-1" });
  state.tick = 100;
  const trader = state.agents[0];
  assert.ok(trader);
  trader.autonomy = true;
  trader.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "trade",
    targetAgentId: "agent-global:garden-1:agent-moved-away",
    offer: { wood: 1, stone: 0, food: 0 },
    request: { wood: 0, stone: 1, food: 0 },
  };
  return { state, traderId: trader.id };
}

test("promoted autonomous trade survives a temporarily remote counterparty", () => {
  const { state, traderId } = remoteTradeState();
  const result = simulate(state);
  const trader = result.state.agents.find((entry) => entry.id === traderId);
  assert.equal(trader?.task?.type, "trade");
  assert.equal(trader?.task?.targetAgentId, "agent-global:garden-1:agent-moved-away");
  assert.match(trader?.status ?? "", /locating trade counterparty/);
});

test("remote trade promise expires after the bounded discovery window", () => {
  const { state, traderId } = remoteTradeState();
  const trader = state.agents.find((entry) => entry.id === traderId);
  assert.ok(trader?.task?.type === "trade");
  trader.task.issuedAtTick = state.tick - 73;
  const result = simulate(state);
  const after = result.state.agents.find((entry) => entry.id === traderId);
  assert.equal(after?.task, undefined);
  assert.equal(after?.status, "remote trade target lookup expired");
});
''')
