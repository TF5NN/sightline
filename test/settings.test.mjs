import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, settingsForPreset, settingsFromAddress, settingsToAddress } from '../js/settings.js';

test('presets: MeshCore default has the network figures and a worked-out sensitivity', () => {
  const s = settingsForPreset('meshcore');
  assert.equal(s.freqMHz, 869.618);
  assert.equal(s.sf, 8);
  assert.equal(s.bw, 62.5);
  assert.equal(s.sensitivity, -130);
  assert.equal(s.detail, 'smart');
  assert.equal(settingsForPreset('meshtastic').sensitivity, -131.5);
  assert.equal(settingsForPreset('fm2m').sensitivity, -119);
  assert.equal(settingsForPreset('nonsense').preset, 'meshcore');
});

test('custom keeps the figures that were showing', () => {
  const before = { ...settingsForPreset('fm70cm'), heightA: 12 };
  const custom = settingsForPreset('custom', before);
  assert.equal(custom.preset, 'custom');
  assert.equal(custom.freqMHz, 433.5);
  assert.equal(custom.heightA, 12);
  assert.equal(custom.lora, false);
});

test('settings survive a round trip through the page address', () => {
  for (const id of Object.keys(PRESETS).filter((p) => p !== 'custom')) {
    const original = { ...settingsForPreset(id), heightA: 7.5, gainB: 5.5, detail: 'full', maxSamples: 50000, powerUnit: 'dBm', k: 1 };
    if (original.lora) original.sf = 10;
    const params = new URLSearchParams(settingsToAddress(original).join('&'));
    const back = settingsFromAddress(params);
    for (const key of ['preset', 'freqMHz', 'heightA', 'gainB', 'detail', 'maxSamples', 'powerUnit', 'k', 'sf', 'bw']) {
      assert.equal(back[key], original[key], `${id}: ${key}`);
    }
    assert.ok(Math.abs(back.powerW - original.powerW) < 1e-3);
  }
});

test('nonsense in the address is ignored, not trusted', () => {
  const s = settingsFromAddress(new URLSearchParams('preset=fm2m&f=abc&ha=-5&hb=99999&sf=3&detail=everything&n=5&k=0'));
  assert.equal(s.freqMHz, 145.5);
  assert.equal(s.heightA, 1.5);
  assert.equal(s.heightB, 1.5);
  assert.equal(s.detail, 'smart');
  assert.equal(s.maxSamples, 20000);
  assert.ok(Math.abs(s.k - 4 / 3) < 1e-9);
});

test('the old "fast" switch still means 10 m only', () => {
  assert.equal(settingsFromAddress(new URLSearchParams('fast=1')).detail, '10m');
});
