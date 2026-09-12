import { createObservationHistory, summarizeWorld } from './world-observation.js';

const percentage = (value) => value === null ? '—' : `${Math.round(value)}%`;
const unitValue = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

// Paths break at unknown samples. Tick spacing is preserved when a connection
// misses updates; the chart never interpolates new simulation observations.
export function observationPath(samples, field, scale = 1) {
  const first = samples[0]?.tick ?? 0;
  const span = Math.max(1, (samples.at(-1)?.tick ?? first) - first);
  let drawing = false;
  return samples.map((sample) => {
    if (!Number.isFinite(sample[field])) { drawing = false; return ''; }
    const x = 3 + ((sample.tick - first) / span) * 250;
    const y = 53 - Math.max(0, Math.min(100, sample[field] * scale)) * 0.48;
    const point = `${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    drawing = true;
    return point;
  }).join(' ');
}

export function createObservationPanel(root) {
  const history = createObservationHistory(60);
  const elements = Object.fromEntries([
    'energy', 'resources', 'crowding', 'infection', 'ground', 'range',
    'energy-line', 'resource-line', 'chart', 'pending',
  ].map((name) => [name, root.querySelector(`#observation-${name}`)]));
  return {
    update(state) {
      const summary = summarizeWorld(state);
      const samples = history.sample(state, summary);
      elements.energy.textContent = percentage(summary.meanEnergy);
      elements.resources.textContent = percentage(summary.resourceRatio === null ? null : summary.resourceRatio * 100);
      elements.crowding.textContent = `${summary.maxCrowding}体 / マス`;
      elements.infection.textContent = `${summary.infectiousAgents}体`;
      elements.ground.textContent = `病原体の残る地面 ${summary.contaminatedCells} / ${summary.activeCells}マス`;
      elements.crowding.title = `3体以上が集まるマス: ${summary.crowdedCells}`;
      elements.range.textContent = samples.length > 1 ? `T${samples[0].tick} – T${samples.at(-1).tick}` : '次の更新を待っています';
      elements.pending.hidden = samples.length > 1;
      elements.chart.hidden = samples.length < 2;
      elements['energy-line'].setAttribute('d', observationPath(samples, 'meanEnergy'));
      elements['resource-line'].setAttribute('d', observationPath(samples, 'resourceRatio', 100));
    },
  };
}

export function updateAgentVitals(root, agent) {
  const energy = Number.isFinite(agent.energy) ? Math.max(0, Math.min(100, agent.energy)) : null;
  const meter = root.querySelector('#agent-energy-meter');
  meter.hidden = energy === null;
  meter.value = energy ?? 0;
  root.querySelector('#agent-energy').textContent = percentage(energy);
  root.querySelector('#agent-pathogen').textContent = `負荷 ${percentage(unitValue(agent.pathogenLoad) * 100)} · 免疫 ${percentage(unitValue(agent.pathogenImmunity) * 100)}`;
}
