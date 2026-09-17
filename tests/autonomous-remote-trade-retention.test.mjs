import assert from "node:assert/strict";
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
