import assert from 'node:assert/strict';
import test from 'node:test';
import { observationPath } from '../public/client/observation-panel.js';

test('observation graph preserves real tick spacing and breaks at unknown measurements', () => {
  const samples = [
    { tick: 0, meanEnergy: 100 }, { tick: 2, meanEnergy: 50 },
    { tick: 4, meanEnergy: null }, { tick: 10, meanEnergy: 0 },
  ];
  assert.equal(observationPath(samples, 'meanEnergy'), 'M3.00,5.00 L53.00,29.00  M253.00,53.00');
  assert.equal(observationPath([], 'meanEnergy'), '');
  assert.equal(observationPath([{ tick: 20, resourceRatio: 0.5 }], 'resourceRatio', 100), 'M3.00,29.00');
});
