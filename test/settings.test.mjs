import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTENNAS,
  BANDS,
  RADIOS,
  antennasFor,
  defaultSettings,
  mirrorStations,
  radiosFor,
  resolveRadio,
  settingsForBand,
  settingsFromAddress,
  settingsToAddress,
} from '../js/settings.js';

const fromLink = (text) => settingsFromAddress(new URLSearchParams(text));

test('the starting setup is a 2 m, 5 W handheld with a rubber duck, link part closed', () => {
  const s = defaultSettings();
  assert.equal(s.band, '2m');
  assert.equal(s.a.radio, 'ht5w');
  assert.equal(s.a.antenna, 'duck');
  assert.equal(s.split, false);
  assert.equal(s.linkOpen, false);
  assert.equal(s.fresnel, false);
  const r = resolveRadio(s);
  assert.equal(r.freqMHz, 145.5);
  assert.equal(r.powerA, 5);
  assert.equal(r.gainA, -3);
  assert.equal(r.sensB, -119);
  assert.equal(r.heightA, 1.5);
});

test('each band only offers radios and antennas made for it', () => {
  assert.deepEqual(radiosFor('2m').map(([id]) => id), ['ht5w', 'mobile50w']);
  assert.deepEqual(radiosFor('lora868').map(([id]) => id), ['meshcore', 'meshtastic']);
  assert.ok(antennasFor('2m').some(([id]) => id === 'yagi3'));
  assert.ok(!antennasFor('70cm').some(([id]) => id === 'yagi3'));
  assert.ok(antennasFor('lora868').every(([id]) => id.endsWith('868')));
  for (const band of Object.keys(BANDS)) {
    const s = settingsForBand(band);
    assert.ok(RADIOS[s.a.radio].bands.includes(band), band);
    assert.ok(ANTENNAS[s.a.antenna].bands.includes(band), band);
  }
});

test('LoRa radios get their frequency and a worked-out sensitivity', () => {
  const r = resolveRadio(settingsForBand('lora868'));
  assert.equal(r.freqMHz, 869.618);
  assert.equal(r.sensA, -130);
  assert.deepEqual(r.lora, { sf: 8, bw: 62.5 });
  const s = settingsForBand('lora868');
  s.a.radio = 'meshtastic';
  assert.equal(resolveRadio(s).freqMHz, 869.525);
  assert.equal(resolveRadio(s).sensA, -131.5);
  s.overrides.sf = 12;
  assert.equal(resolveRadio(s).sensA, -134);
});

test('one station: both ends follow A; two stations: each end is its own', () => {
  const s = defaultSettings();
  s.a.antenna = 'yagi3';
  s.b.antenna = 'duck'; // ignored while the ends are tied together
  let r = resolveRadio(s);
  assert.equal(r.gainA, 6.5);
  assert.equal(r.gainB, 6.5);
  s.split = true;
  s.b.radio = 'mobile50w';
  s.b.antenna = 'collinear';
  r = resolveRadio(s);
  assert.equal(r.gainA, 6.5);
  assert.equal(r.gainB, 6);
  assert.equal(r.powerA, 5);
  assert.equal(r.powerB, 50);
  const tied = mirrorStations({ ...s, split: false });
  assert.equal(tied.b.radio, 'ht5w');
  assert.equal(tied.b.antenna, 'yagi3');
});

test('numbers typed by hand win over the lists', () => {
  const s = defaultSettings();
  s.split = true;
  s.overrides = { freqMHz: 145.05, gainB: 8, cableB: 1.5, sensB: -122 };
  const r = resolveRadio(s);
  assert.equal(r.freqMHz, 145.05);
  assert.equal(r.gainA, -3);
  assert.equal(r.gainB, 8);
  assert.equal(r.cableB, 1.5);
  assert.equal(r.sensB, -122);
  assert.equal(r.sensA, -119);
});

test('a setup survives a round trip through the page address', () => {
  const s = settingsForBand('2m');
  Object.assign(s, { split: true, linkOpen: true, fresnel: true, detail: 'full', maxSamples: 50000, powerUnit: 'dBm', k: 1 });
  s.a = { radio: 'ht5w', antenna: 'yagi3', height: 2 };
  s.b = { radio: 'mobile50w', antenna: 'collinear', height: 12.5 };
  s.overrides = { freqMHz: 145.05, cableB: 1.5 };
  const back = fromLink(settingsToAddress(s).join('&'));
  assert.deepEqual(back, s);
  // And the plain starting setup stays short.
  assert.deepEqual(settingsToAddress(defaultSettings()), ['band=2m', 'ra=ht5w', 'aa=duck', 'ha=1.5', 'hb=1.5']);
  assert.deepEqual(fromLink(settingsToAddress(defaultSettings()).join('&')), defaultSettings());
});

test('nonsense in the address is ignored, not trusted', () => {
  const s = fromLink('band=11m&ra=meshcore&aa=yagi868&ha=-5&hb=99999&f=abc&ga=500&detail=everything&n=5&k=0');
  assert.equal(s.band, '2m');
  assert.equal(s.a.radio, 'ht5w', 'a LoRa radio is not offered on the 2 m band');
  assert.equal(s.a.antenna, 'duck');
  assert.equal(s.a.height, 1.5);
  assert.equal(s.b.height, 1.5);
  assert.deepEqual(s.overrides, {});
  assert.equal(s.detail, 'smart');
  assert.equal(s.maxSamples, 20000);
});

test('links from the earlier version still open with the same numbers', () => {
  // The Bláfjöll field check, duck version.
  const s = fromLink('preset=fm2m&f=145.05&p=5&ha=10&hb=1.5&ga=6&gb=-3&ca=1.5&cb=0&s=-119');
  assert.equal(s.band, '2m');
  assert.equal(s.linkOpen, true);
  assert.equal(s.split, true);
  const r = resolveRadio(s);
  assert.equal(r.freqMHz, 145.05);
  assert.equal(r.gainA, 6);
  assert.equal(r.gainB, -3);
  assert.equal(r.cableA, 1.5);
  assert.equal(r.heightA, 10);
  assert.equal(r.heightB, 1.5);
  assert.equal(r.powerA, 5);
  assert.equal(r.sensA, -119);
  const lora = resolveRadio(fromLink('preset=meshcore&f=869.618&p=0.158&ha=2&hb=2&ga=2&gb=2&ca=0&cb=0&sf=8&bw=62.5'));
  assert.equal(lora.freqMHz, 869.618);
  assert.equal(lora.sensA, -130);
  assert.equal(lora.gainA, 2);
  assert.equal(fromLink('fast=1').detail, '10m');
});
