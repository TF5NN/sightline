// The radio settings: the ready-made setups, their defaults, and how they are
// read from and written to the page address so a link can be shared.
// No page elements in here, so it can be tested on its own.

import { loraSensitivity } from './radio.js';

// Ready-made setups. LoRa figures are the networks' own defaults, checked
// against MeshCore and Meshtastic documentation in November 2026. Antenna
// gains and heights are typical starting points, meant to be changed. A stock
// rubber-duck antenna is put at -3 dBi; many are worse.
export const PRESETS = {
  meshcore: {
    label: 'MeshCore (EU/UK narrow, 869.618 MHz)',
    lora: true,
    freqMHz: 869.618, powerW: 0.158, sf: 8, bw: 62.5,
    gainA: 2, gainB: 2, cableA: 0, cableB: 0, heightA: 2, heightB: 2,
  },
  meshtastic: {
    label: 'Meshtastic LongFast (EU 868, 869.525 MHz)',
    lora: true,
    freqMHz: 869.525, powerW: 0.158, sf: 11, bw: 250,
    gainA: 2, gainB: 2, cableA: 0, cableB: 0, heightA: 2, heightB: 2,
  },
  fm2m: {
    label: '2 m FM handheld (145.5 MHz, 5 W, rubber duck)',
    lora: false,
    freqMHz: 145.5, powerW: 5, sensitivity: -119,
    gainA: -3, gainB: -3, cableA: 0, cableB: 0, heightA: 1.5, heightB: 1.5,
  },
  fm70cm: {
    label: '70 cm FM handheld (433.5 MHz, 5 W, rubber duck)',
    lora: false,
    freqMHz: 433.5, powerW: 5, sensitivity: -119,
    gainA: -3, gainB: -3, cableA: 0, cableB: 0, heightA: 1.5, heightB: 1.5,
  },
  custom: { label: 'Custom (type your own figures)', lora: false },
};

export const DEFAULT_PRESET = 'meshcore';
export const DEFAULT_MAX_SAMPLES = 20000;
export const DEFAULT_K = 4 / 3;
export const DETAIL_MODES = ['smart', 'full', '10m'];

/** All settings for a preset, filled in and ready to use. */
export function settingsForPreset(presetId, previous = null) {
  const preset = PRESETS[presetId] ?? PRESETS[DEFAULT_PRESET];
  const id = PRESETS[presetId] ? presetId : DEFAULT_PRESET;
  // "Custom" keeps whatever figures were showing.
  const base = id === 'custom' && previous ? previous : { sf: 8, bw: 62.5, sensitivity: -119, ...preset };
  const settings = {
    preset: id,
    lora: id === 'custom' ? false : preset.lora,
    freqMHz: base.freqMHz,
    powerW: base.powerW,
    gainA: base.gainA,
    gainB: base.gainB,
    cableA: base.cableA,
    cableB: base.cableB,
    heightA: base.heightA,
    heightB: base.heightB,
    sf: base.sf,
    bw: base.bw,
    sensitivity: base.sensitivity,
    powerUnit: previous?.powerUnit ?? 'W',
    detail: previous?.detail ?? 'smart',
    maxSamples: previous?.maxSamples ?? DEFAULT_MAX_SAMPLES,
    k: previous?.k ?? DEFAULT_K,
  };
  return withSensitivity(settings);
}

/** For LoRa setups the sensitivity follows from spreading factor and bandwidth. */
export function withSensitivity(settings) {
  if (!settings.lora) return settings;
  return { ...settings, sensitivity: Math.round(loraSensitivity(settings.sf, settings.bw) * 10) / 10 };
}

// Short names used in the page address.
const ADDRESS_KEYS = {
  freqMHz: 'f', powerW: 'p', heightA: 'ha', heightB: 'hb', gainA: 'ga', gainB: 'gb',
  cableA: 'ca', cableB: 'cb', sf: 'sf', bw: 'bw', sensitivity: 's',
};

const trim = (n) => String(Math.round(n * 1000) / 1000);

/** The settings as "key=value" pieces for the page address. */
export function settingsToAddress(settings) {
  const parts = [`preset=${settings.preset}`];
  for (const [name, key] of Object.entries(ADDRESS_KEYS)) {
    if ((name === 'sf' || name === 'bw') && !settings.lora) continue;
    if (name === 'sensitivity' && settings.lora) continue;
    parts.push(`${key}=${trim(settings[name])}`);
  }
  if (settings.powerUnit !== 'W') parts.push(`pu=${settings.powerUnit}`);
  if (settings.detail !== 'smart') parts.push(`detail=${settings.detail}`);
  if (settings.maxSamples !== DEFAULT_MAX_SAMPLES) parts.push(`n=${settings.maxSamples}`);
  if (Math.abs(settings.k - DEFAULT_K) > 1e-6) parts.push(`k=${trim(settings.k)}`);
  return parts;
}

const LIMITS = {
  freqMHz: [1, 100000], powerW: [0.000001, 100000], heightA: [0, 1000], heightB: [0, 1000],
  gainA: [-30, 60], gainB: [-30, 60], cableA: [0, 100], cableB: [0, 100],
  sensitivity: [-200, 0],
};

/** Read settings back out of the page address. Anything missing or nonsensical keeps its default. */
export function settingsFromAddress(params) {
  let settings = settingsForPreset(params.get('preset') ?? DEFAULT_PRESET);
  for (const [name, key] of Object.entries(ADDRESS_KEYS)) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (!Number.isFinite(value)) continue;
    if (name === 'sf') {
      if ([7, 8, 9, 10, 11, 12].includes(value)) settings.sf = value;
    } else if (name === 'bw') {
      if ([62.5, 125, 250, 500].includes(value)) settings.bw = value;
    } else if (value >= LIMITS[name][0] && value <= LIMITS[name][1]) {
      settings[name] = value;
    }
  }
  if (params.get('pu') === 'dBm') settings.powerUnit = 'dBm';
  if (DETAIL_MODES.includes(params.get('detail'))) settings.detail = params.get('detail');
  // The earlier "fast=1" switch meant 10 m only.
  if (params.get('fast') === '1') settings.detail = '10m';
  const n = Number(params.get('n'));
  if (Number.isFinite(n) && n >= 2000 && n <= 200000) settings.maxSamples = Math.round(n);
  const k = Number(params.get('k'));
  if (params.has('k') && Number.isFinite(k) && k >= 0.5 && k <= 10) settings.k = k;
  settings = withSensitivity(settings);
  return settings;
}
