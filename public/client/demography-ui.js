const LIFE_STAGE_LABELS = Object.freeze({
  infant: "乳児",
  juvenile: "若年",
  adult: "成人",
  elder: "高齢",
});

function lifeStage(agent) {
  return Object.hasOwn(LIFE_STAGE_LABELS, agent?.lifeStage) ? agent.lifeStage : "adult";
}

function displayParent(parentId, agentsById) {
  const parent = agentsById.get(parentId);
  return parent?.name ? `${parent.name} (${parentId})` : parentId;
}

export function agentDemography(agent, state) {
  const tick = Number.isSafeInteger(state?.tick) ? state.tick : 0;
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const stage = lifeStage(agent);
  const ageTicks = Number.isSafeInteger(agent?.birthTick)
    ? Math.max(0, tick - agent.birthTick)
    : undefined;
  const parents = Array.isArray(agent?.parents) && agent.parents.length === 2
    ? agent.parents.map((parentId) => displayParent(parentId, agentsById)).join(" / ")
    : "—（創始個体）";
  const dueAtTick = agent?.pregnancy?.dueAtTick;
  const pregnancy = Number.isSafeInteger(dueAtTick)
    ? `妊娠中 · あと${Math.max(0, dueAtTick - tick)} tick`
    : "—";
  return {
    age: ageTicks === undefined ? "不明（既存個体）" : `${ageTicks} tick`,
    lifeStage: LIFE_STAGE_LABELS[stage],
    parents,
    pregnancy,
  };
}

export function populationComposition(state) {
  const counts = { infant: 0, juvenile: 0, adult: 0, elder: 0 };
  let pregnant = 0;
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  for (const agent of agents) {
    counts[lifeStage(agent)] += 1;
    if (agent?.pregnancy && Number.isSafeInteger(agent.pregnancy.dueAtTick)) pregnant += 1;
  }
  return `乳児 ${counts.infant} · 若年 ${counts.juvenile} · 成人 ${counts.adult} · 高齢 ${counts.elder} · 妊娠 ${pregnant}`;
}
