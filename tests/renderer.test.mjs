import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_QUALITY_PRESETS, QUALITY_PRESETS, resolveQuality } from '../web/renderer.js';

test('phone-sized coarse-pointer viewports use a responsive render budget', () => {
  assert.equal(resolveQuality('high', 390, { coarsePointer: true }), MOBILE_QUALITY_PRESETS.high);
  assert.ok(MOBILE_QUALITY_PRESETS.high.steps < QUALITY_PRESETS.high.steps);
  assert.ok(MOBILE_QUALITY_PRESETS.high.dprLimit < QUALITY_PRESETS.high.dprLimit);
});

test('desktop and large touch viewports retain their selected quality tier', () => {
  assert.equal(resolveQuality('high', 1024, { coarsePointer: true }), QUALITY_PRESETS.high);
  assert.equal(resolveQuality('balanced', 390, { coarsePointer: false }), QUALITY_PRESETS.balanced);
  assert.equal(resolveQuality('unknown', 390, { coarsePointer: true }), MOBILE_QUALITY_PRESETS.balanced);
});
