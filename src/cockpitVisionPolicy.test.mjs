import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from './cockpitVisionPolicy.js';

const createStages = () => ({
  surveillance: { uniforms: { intensity: 0.72, grain: 0.6 } },
  thermal: { uniforms: { intensity: 0, heat: 0.8 } },
});

test('Cockpit vision order exposes inherited, NVG, and FLIR modes', () => {
  assert.deepEqual(COCKPIT_VISION_MODES, ['optical', 'nvg', 'thermal']);
  assert.equal(normalizeCockpitVisionMode('none'), 'optical');
  assert.equal(normalizeCockpitVisionMode('unknown'), 'optical');
});

test('Cockpit settles pending map crossfades before a temporary preset takes ownership', () => {
  const stages = createStages();
  const transitions = new Map([
    ['surveillance', { from: 0, to: 1, start: 10 }],
    ['thermal', { from: 1, to: 0, start: 10 }],
  ]);
  const restore = captureCockpitVisionBaseline(stages, transitions);
  assert.deepEqual(restore, { surveillance: 1, thermal: 0 });
  assert.equal(transitions.size, 0);
  applyCockpitVisionStageIntensities(stages, 'thermal', restore);
  assert.equal(stages.thermal.uniforms.intensity, 1);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.surveillance.uniforms.intensity, 1);
  assert.equal(stages.thermal.uniforms.intensity, 0);
});

test('returning from a temporary preset restores the exact inherited intensities', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal', restore);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.deepEqual(
    Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity])),
    restore,
  );
});

test('temporary styles replace each other without changing the inherited restore snapshot', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal', restore);
  assert.equal(applyCockpitVisionStageIntensities(stages, 'nvg', restore), 'surveillance');
  assert.equal(stages.surveillance.uniforms.intensity, 1);
  assert.equal(stages.thermal.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.surveillance.uniforms.intensity, 0.72);
  assert.equal(stages.thermal.uniforms.intensity, 0);
});

test('NVG is a temporary Cockpit override and inherited restores the captured map style', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [name, stage.uniforms.intensity]),
  );
  assert.equal(applyCockpitVisionStageIntensities(stages, 'nvg', restore), 'surveillance');
  assert.equal(stages.surveillance.uniforms.intensity, 1);
  assert.equal(stages.thermal.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical', restore);
  assert.equal(stages.surveillance.uniforms.intensity, 0.72);
  assert.equal(stages.thermal.uniforms.intensity, 0);
});
