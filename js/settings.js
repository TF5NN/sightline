// The station choices (band, radio, antenna), their defaults, and how the
// whole setup is read from and written to the page address so a link can be
// shared. No page elements in here, so it can be tested on its own.
//
// The idea: pick a band, then a radio made for that band, then an antenna.
// Each choice fills in the numbers (frequency, power, sensitivity, gain).
// Anyone who wants to type their own numbers can do so under Advanced; those
// are kept as "overrides" on top of the choices.

import { loraSensitivity } from './radio.js';

export const BANDS = {
  '2m': { label: '2 m (145 MHz)', freqMHz: 145.5 },
  '70cm': { label: '70 cm (433 MHz)', freqMHz: 433.5 },
  lora868: { label: '868 MHz (LoRa mesh)', freqMHz: 869.618 },
  // The services below are PLACEHOLDERS: rough, typical figures to make the
  // tool useful outside amateur radio. Nobody who works with these services
  // has checked them yet, and legal power limits are not checked at all.
  pmr446: { label: 'PMR446 walkie-talkie (446 MHz)', freqMHz: 446.1 },
  marine: { label: 'Marine VHF (156.8 MHz)', freqMHz: 156.8 },
  wifi24: { label: 'Wi-Fi link (2.4 GHz)', freqMHz: 2437 },
  wifi5: { label: 'Wi-Fi link (5 GHz)', freqMHz: 5500 },
  cell800: { label: 'Mobile network, 800 MHz (4G/5G)', freqMHz: 800 },
  cell3500: { label: 'Mobile network, 3.5 GHz (5G)', freqMHz: 3500 },
  fmbc: { label: 'FM broadcast (98 MHz)', freqMHz: 98 },
};

// LoRa figures are the networks' own defaults, checked against MeshCore and
// Meshtastic documentation in November 2026. -119 dBm is the usual figure for
// an FM receiver, and means "just readable".
export const RADIOS = {
  ht5w: { bands: ['2m', '70cm'], label: 'Handheld, 5 W', powerW: 5, sensitivity: -119 },
  mobile50w: { bands: ['2m', '70cm'], label: 'Mobile or base, 50 W', powerW: 50, sensitivity: -119 },
  repeater: { bands: ['2m', '70cm'], label: 'Repeater, 25 W', powerW: 25, sensitivity: -119 },
  meshcore: {
    bands: ['lora868'],
    label: 'MeshCore node (EU/UK narrow)',
    powerW: 0.158,
    freqMHz: 869.618,
    lora: { sf: 8, bw: 62.5 },
  },
  meshtastic: {
    bands: ['lora868'],
    label: 'Meshtastic node (LongFast)',
    powerW: 0.158,
    freqMHz: 869.525,
    lora: { sf: 11, bw: 250 },
  },
  // Placeholders from here on (see BANDS). A power of 0 means "receives only":
  // the link is then judged in the one direction that exists.
  pmr: { bands: ['pmr446'], label: 'PMR446 handheld, 0.5 W', powerW: 0.5, sensitivity: -119 },
  marine25: { bands: ['marine'], label: 'Fixed marine radio, 25 W', powerW: 25, sensitivity: -119 },
  marine5: { bands: ['marine'], label: 'Handheld marine radio, 5 W', powerW: 5, sensitivity: -119 },
  wifi: { bands: ['wifi24', 'wifi5'], label: 'Outdoor Wi-Fi radio, 100 mW', powerW: 0.1, sensitivity: -92 },
  celltower: { bands: ['cell800', 'cell3500'], label: 'Base station (cell tower)', powerW: 40, sensitivity: -104 },
  phone: { bands: ['cell800', 'cell3500'], label: 'Phone or 4G/5G router', powerW: 0.2, sensitivity: -100 },
  bctx1k: { bands: ['fmbc'], label: 'Broadcast transmitter, 1 kW', powerW: 1000, sensitivity: -95 },
  bctx100: { bands: ['fmbc'], label: 'Relay transmitter, 100 W', powerW: 100, sensitivity: -95 },
  fmrx: { bands: ['fmbc'], label: 'FM radio (receives only)', powerW: 0, sensitivity: -95 },
};

// Gains are typical figures, in dBi. A stock rubber duck is put at -3 dBi; many are worse.
export const ANTENNAS = {
  duck: { bands: ['2m', '70cm'], label: 'Rubber duck', gain: -3 },
  quarter: { bands: ['2m', '70cm'], label: 'Quarter-wave whip', gain: 2 },
  mobilewhip: { bands: ['2m', '70cm'], label: 'Mobile whip (5/8 wave)', gain: 3.5 },
  collinear: { bands: ['2m', '70cm'], label: 'Collinear base antenna', gain: 6 },
  yagi3: { bands: ['2m'], label: '3-element yagi', gain: 6.5 },
  yagi7: { bands: ['70cm'], label: '7-element yagi', gain: 10 },
  stub868: { bands: ['lora868'], label: 'Small stub antenna', gain: 0 },
  whip868: { bands: ['lora868'], label: 'Whip antenna', gain: 2 },
  collinear868: { bands: ['lora868'], label: 'Collinear antenna', gain: 5 },
  yagi868: { bands: ['lora868'], label: 'Yagi', gain: 9 },
  // Placeholders from here on (see BANDS).
  pmrbuiltin: { bands: ['pmr446'], label: 'Built-in antenna', gain: 0 },
  marinewhip: { bands: ['marine'], label: 'Boat whip antenna', gain: 3 },
  marineht: { bands: ['marine'], label: 'Handheld antenna', gain: -3 },
  marinecoast: { bands: ['marine'], label: 'Shore station collinear', gain: 6 },
  wifiomni: { bands: ['wifi24', 'wifi5'], label: 'Omni antenna', gain: 8 },
  wifipanel: { bands: ['wifi24', 'wifi5'], label: 'Panel antenna', gain: 16 },
  wifigrid: { bands: ['wifi24'], label: 'Grid dish', gain: 24 },
  wifidish: { bands: ['wifi5'], label: 'Dish', gain: 30 },
  cellsector: { bands: ['cell800'], label: 'Sector antenna', gain: 16 },
  cellmimo: { bands: ['cell3500'], label: 'Antenna panel (massive MIMO)', gain: 24 },
  phoneant: { bands: ['cell800', 'cell3500'], label: 'Phone in the hand', gain: -3 },
  cellexternal: { bands: ['cell800', 'cell3500'], label: 'Outdoor directional antenna', gain: 9 },
  bcarray: { bands: ['fmbc'], label: 'Mast antenna array', gain: 7 },
  fmwhip: { bands: ['fmbc'], label: 'Car or portable radio whip', gain: -2 },
  fmroof: { bands: ['fmbc'], label: 'Rooftop FM antenna', gain: 4 },
};

// What each band starts on. With a "b", the two ends start as different stations.
const BAND_DEFAULTS = {
  '2m': { radio: 'ht5w', antenna: 'duck', height: 1.5 },
  '70cm': { radio: 'ht5w', antenna: 'duck', height: 1.5 },
  lora868: { radio: 'meshcore', antenna: 'whip868', height: 2 },
  pmr446: { radio: 'pmr', antenna: 'pmrbuiltin', height: 1.5 },
  marine: { radio: 'marine25', antenna: 'marinewhip', height: 4 },
  wifi24: { radio: 'wifi', antenna: 'wifigrid', height: 8 },
  wifi5: { radio: 'wifi', antenna: 'wifidish', height: 8 },
  cell800: { radio: 'celltower', antenna: 'cellsector', height: 30, b: { radio: 'phone', antenna: 'phoneant', height: 1.5 } },
  cell3500: { radio: 'celltower', antenna: 'cellmimo', height: 30, b: { radio: 'phone', antenna: 'phoneant', height: 1.5 } },
  fmbc: { radio: 'bctx1k', antenna: 'bcarray', height: 50, b: { radio: 'fmrx', antenna: 'fmwhip', height: 1.5 } },
};

/** The two stations a band starts on, and whether they differ. */
export function bandStart(bandId) {
  const { b, ...a } = BAND_DEFAULTS[BANDS[bandId] ? bandId : DEFAULT_BAND];
  return { a: { ...a }, b: { ...(b ?? a) }, split: Boolean(b) };
}

export const DEFAULT_BAND = '2m';
export const DEFAULT_MAX_SAMPLES = 20000;
export const DEFAULT_K = 4 / 3;
export const DETAIL_MODES = ['smart', 'full', '10m'];

// The numbers that can be typed by hand under Advanced.
export const OVERRIDE_KEYS = ['freqMHz', 'powerA', 'powerB', 'gainA', 'gainB', 'cableA', 'cableB', 'sensA', 'sensB', 'sf', 'bw'];

export const radiosFor = (band) => Object.entries(RADIOS).filter(([, r]) => r.bands.includes(band));
export const antennasFor = (band) => Object.entries(ANTENNAS).filter(([, a]) => a.bands.includes(band));

/** A fresh setup for a band: the stations it starts on, nothing typed by hand. */
export function settingsForBand(bandId, previous = null) {
  const band = BANDS[bandId] ? bandId : DEFAULT_BAND;
  const start = bandStart(band);
  return {
    band,
    split: start.split, // true = a different station at each end
    a: start.a,
    b: start.b,
    overrides: {},
    linkOpen: previous?.linkOpen ?? false, // is the "estimate radio link" part showing?
    fresnel: previous?.fresnel ?? true, // draw the Fresnel zone while the radio link part is open?
    powerUnit: previous?.powerUnit ?? 'W',
    detail: previous?.detail ?? 'smart',
    maxSamples: previous?.maxSamples ?? DEFAULT_MAX_SAMPLES,
    k: previous?.k ?? DEFAULT_K,
  };
}

export const defaultSettings = () => settingsForBand(DEFAULT_BAND);

/** Make B a copy of A again (used when "different station at each end" is switched off). */
export function mirrorStations(settings) {
  const o = { ...settings.overrides };
  for (const key of ['power', 'gain', 'cable', 'sens']) {
    if (o[`${key}A`] !== undefined) o[`${key}B`] = o[`${key}A`];
    else delete o[`${key}B`];
  }
  return { ...settings, b: { ...settings.b, radio: settings.a.radio, antenna: settings.a.antenna }, overrides: o };
}

/**
 * Turn the choices into the numbers the radio maths needs.
 * Anything typed by hand under Advanced wins over the lists.
 */
export function resolveRadio(settings) {
  const band = BANDS[settings.band];
  const o = settings.overrides;
  const pick = (value, fallback) => (value === undefined ? fallback : value);
  const end = (station, letter) => {
    const radio = RADIOS[station.radio];
    const antenna = ANTENNAS[station.antenna];
    const sf = pick(o.sf, radio.lora?.sf);
    const bw = pick(o.bw, radio.lora?.bw);
    const sensitivity = radio.lora ? Math.round(loraSensitivity(sf, bw) * 10) / 10 : radio.sensitivity;
    return {
      powerW: pick(o[`power${letter}`], radio.powerW),
      gain: pick(o[`gain${letter}`], antenna.gain),
      cable: pick(o[`cable${letter}`], 0),
      sensitivity: pick(o[`sens${letter}`], sensitivity),
      height: station.height,
      lora: radio.lora ? { sf, bw } : null,
    };
  };
  const a = end(settings.a, 'A');
  const b = end(settings.split ? settings.b : { ...settings.a, height: settings.b.height }, 'B');
  if (!settings.split) {
    // One station: B follows A, including anything typed by hand for A.
    b.powerW = a.powerW;
    b.gain = a.gain;
    b.cable = a.cable;
    b.sensitivity = a.sensitivity;
  }
  return {
    freqMHz: pick(o.freqMHz, RADIOS[settings.a.radio].freqMHz ?? band.freqMHz),
    powerA: a.powerW,
    powerB: b.powerW,
    gainA: a.gain,
    gainB: b.gain,
    cableA: a.cable,
    cableB: b.cable,
    sensA: a.sensitivity,
    sensB: b.sensitivity,
    heightA: a.height,
    heightB: b.height,
    lora: a.lora,
    k: settings.k,
  };
}

// ---------------------------------------------------------------------------
// The page address
// ---------------------------------------------------------------------------

const OVERRIDE_ADDRESS = {
  freqMHz: 'f', powerA: 'pa', powerB: 'pb', gainA: 'ga', gainB: 'gb',
  cableA: 'ca', cableB: 'cb', sensA: 'sa', sensB: 'sb', sf: 'sf', bw: 'bw',
};

const LIMITS = {
  freqMHz: [1, 100000], powerA: [0.000001, 100000], powerB: [0.000001, 100000],
  gainA: [-30, 60], gainB: [-30, 60], cableA: [0, 100], cableB: [0, 100],
  sensA: [-200, 0], sensB: [-200, 0], height: [0, 1000],
};
const SF_VALUES = [7, 8, 9, 10, 11, 12];
const BW_VALUES = [62.5, 125, 250, 500];

export function validOverride(name, value) {
  if (!Number.isFinite(value)) return false;
  if (name === 'sf') return SF_VALUES.includes(value);
  if (name === 'bw') return BW_VALUES.includes(value);
  return value >= LIMITS[name][0] && value <= LIMITS[name][1];
}

const trim = (n) => String(Math.round(n * 1000) / 1000);

/** The setup as "key=value" pieces for the page address. */
export function settingsToAddress(s) {
  const parts = [`band=${s.band}`, `ra=${s.a.radio}`, `aa=${s.a.antenna}`, `ha=${trim(s.a.height)}`, `hb=${trim(s.b.height)}`];
  if (s.split) parts.push('split=1', `rb=${s.b.radio}`, `ab=${s.b.antenna}`);
  for (const [name, key] of Object.entries(OVERRIDE_ADDRESS)) {
    if (s.overrides[name] === undefined) continue;
    if (!s.split && name.endsWith('B')) continue;
    parts.push(`${key}=${trim(s.overrides[name])}`);
  }
  if (s.linkOpen) parts.push('link=1');
  if (!s.fresnel) parts.push('fz=0');
  if (s.powerUnit !== 'W') parts.push(`pu=${s.powerUnit}`);
  if (s.detail !== 'smart') parts.push(`detail=${s.detail}`);
  if (s.maxSamples !== DEFAULT_MAX_SAMPLES) parts.push(`n=${s.maxSamples}`);
  if (Math.abs(s.k - DEFAULT_K) > 1e-6) parts.push(`k=${trim(s.k)}`);
  return parts;
}

// Links made before the band / radio / antenna lists existed used "preset=".
const OLD_PRESETS = {
  meshcore: { band: 'lora868', radio: 'meshcore', antenna: 'whip868' },
  meshtastic: { band: 'lora868', radio: 'meshtastic', antenna: 'whip868' },
  fm2m: { band: '2m', radio: 'ht5w', antenna: 'duck' },
  fm70cm: { band: '70cm', radio: 'ht5w', antenna: 'duck' },
  custom: { band: '2m', radio: 'ht5w', antenna: 'duck' },
};

function fromOldAddress(params) {
  const old = OLD_PRESETS[params.get('preset')] ?? OLD_PRESETS.fm2m;
  const s = settingsForBand(old.band);
  s.a.radio = old.radio;
  s.b.radio = old.radio;
  s.a.antenna = old.antenna;
  s.b.antenna = old.antenna;
  s.linkOpen = true; // those links were always link estimates
  s.fresnel = true; // and always showed the Fresnel zone
  const number = (key) => (params.has(key) ? Number(params.get(key)) : NaN);
  const set = (name, value) => {
    if (validOverride(name, value)) s.overrides[name] = value;
  };
  set('freqMHz', number('f'));
  set('powerA', number('p'));
  set('powerB', number('p'));
  set('gainA', number('ga'));
  set('gainB', number('gb'));
  set('cableA', number('ca'));
  set('cableB', number('cb'));
  if (!RADIOS[old.radio].lora) {
    set('sensA', number('s'));
    set('sensB', number('s'));
  }
  set('sf', number('sf'));
  set('bw', number('bw'));
  // The old page had one gain and one cable box per end, so the ends could differ.
  s.split = s.overrides.gainA !== s.overrides.gainB || s.overrides.cableA !== s.overrides.cableB;
  return s;
}

/** Read a setup back out of the page address. Anything missing or nonsensical keeps its default. */
export function settingsFromAddress(params) {
  let s;
  if (params.has('preset') && !params.has('band')) {
    s = fromOldAddress(params);
  } else {
    s = settingsForBand(params.get('band') ?? DEFAULT_BAND);
    const choose = (table, id, fallback) => (table[id]?.bands.includes(s.band) ? id : fallback);
    s.a.radio = choose(RADIOS, params.get('ra'), s.a.radio);
    s.a.antenna = choose(ANTENNAS, params.get('aa'), s.a.antenna);
    s.split = params.get('split') === '1';
    s.b.radio = s.split ? choose(RADIOS, params.get('rb'), s.a.radio) : s.a.radio;
    s.b.antenna = s.split ? choose(ANTENNAS, params.get('ab'), s.a.antenna) : s.a.antenna;
    for (const [name, key] of Object.entries(OVERRIDE_ADDRESS)) {
      if (!params.has(key)) continue;
      const value = Number(params.get(key));
      if (validOverride(name, value)) s.overrides[name] = value;
    }
    s.linkOpen = params.get('link') === '1';
    s.fresnel = params.get('fz') !== '0';
  }
  for (const [end, key] of [['a', 'ha'], ['b', 'hb']]) {
    const h = Number(params.get(key));
    if (params.has(key) && Number.isFinite(h) && h >= LIMITS.height[0] && h <= LIMITS.height[1]) s[end].height = h;
  }
  if (params.get('pu') === 'dBm') s.powerUnit = 'dBm';
  if (DETAIL_MODES.includes(params.get('detail'))) s.detail = params.get('detail');
  if (params.get('fast') === '1') s.detail = '10m'; // the very first version's switch
  const n = Number(params.get('n'));
  if (Number.isFinite(n) && n >= 2000 && n <= 200000) s.maxSamples = Math.round(n);
  const k = Number(params.get('k'));
  if (params.has('k') && Number.isFinite(k) && k >= 0.5 && k <= 10) s.k = k;
  return s;
}
