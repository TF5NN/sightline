// Station layers: reads data/stations.csv (repeaters and other fixed stations)
// and turns each line into something the map can show and the radio part can
// use. No page elements in here, so it can be tested on its own.
//
// The sheet is meant to be edited by hand, in a spreadsheet, so the reading is
// forgiving: commas or semicolons between columns, decimal commas, any column
// order, and a byte-order mark at the start are all accepted.

import { named, t } from './i18n.js';
import { ANTENNAS, BANDS, RADIOS, antennasFor, mirrorStations, settingsForBand } from './settings.js';

// The tick-box name for each layer is in js/strings.js, as "layer." and the word in the
// sheet's "layer" column, in both languages. A layer that is not listed there still
// works; it is named after that word.
export const layerName = (id) => named(`layer.${id}`, id);

// Used where the sheet has no figure. The app says so next to each one.
export const ASSUMED = { powerW: 25, gainDbi: 6, heightM: 10, cableDb: 0 };

/** Split CSV text into rows of cells. Handles quoted cells and both , and ; as the separator. */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const count = (ch) => firstLine.split(ch).length;
  const separator = count(';') > count(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** A number from a cell; accepts a decimal comma. Empty or not a number gives null. */
function number(cell) {
  const text = (cell ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const isYes = (cell) => /^(yes|y|true|1|já|ja)$/i.test((cell ?? '').trim());

/**
 * Read the sheet. Gives { stations, problems }: every station marked to be
 * shown that has a usable position, and a plain sentence for each line that
 * was marked to be shown but could not be used.
 */
export function readStations(text) {
  const rows = parseCsv(text);
  const stations = [];
  const problems = [];
  if (rows.length === 0) return { stations, problems: ['The stations sheet is empty.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const used = new Set();
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const get = (name) => (cells[header.indexOf(name)] ?? '').trim();
    const layer = get('layer').toLowerCase();
    if (!layer || !isYes(get('show'))) return;
    const name = get('name');
    const callsign = get('callsign');
    const who = [callsign, name].filter(Boolean).join(' ') || `line ${line}`;
    const lat = number(get('lat'));
    const lon = number(get('lon'));
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      problems.push(`${who} (line ${line}) has no usable position.`);
      return;
    }
    const frequency = (column) => {
      const value = number(get(column));
      if (get(column) !== '' && (value === null || value <= 0)) problems.push(`${who} (line ${line}): ${column} is not a number.`);
      return value !== null && value > 0 ? value : null;
    };
    const outputMHz = frequency('output_mhz');
    const inputMHz = frequency('input_mhz');
    // What links and the page use to tell stations apart.
    let id = (callsign || name).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || `line-${line}`;
    while (used.has(id.toLowerCase())) id += '-2';
    used.add(id.toLowerCase());

    const given = { powerW: number(get('power_w')), gainDbi: number(get('gain_dbi')), heightM: number(get('height_m')), cableDb: number(get('cable_db')) };
    const assumed = Object.keys(given).filter((key) => given[key] === null && key !== 'cableDb');
    stations.push({
      id,
      layer,
      callsign,
      name,
      type: get('type'),
      outputMHz,
      inputMHz,
      tone: get('tone'),
      lat,
      lon,
      powerW: given.powerW ?? ASSUMED.powerW,
      gainDbi: given.gainDbi ?? ASSUMED.gainDbi,
      heightM: given.heightM ?? ASSUMED.heightM,
      cableDb: given.cableDb ?? ASSUMED.cableDb,
      assumed, // which of powerW, gainDbi, heightM were not in the sheet
      antenna: get('antenna'),
      status: get('status'),
      confidence: get('position_confidence'),
      source: get('source'),
      notes: get('notes'),
      notesIs: get('notes_is'), // the same notes in Icelandic, if the sheet has them
    });
  });
  return { stations, problems };
}

/** The band a frequency belongs to, as people say it: "2 m", "70 cm", or the frequency itself. */
export function bandWords(mhz) {
  if (!Number.isFinite(mhz)) return '';
  if (mhz >= 144 && mhz <= 148) return '2 m';
  if (mhz >= 420 && mhz <= 450) return '70 cm';
  if (mhz >= 50 && mhz <= 54) return '6 m';
  if (mhz >= 1240 && mhz <= 1300) return '23 cm';
  return `${Math.round(mhz)} MHz`;
}

/** "2 m FM", "70 cm D-STAR": the band and the type together. */
export const stationKind = (station) => [bandWords(station.outputMHz ?? station.inputMHz), station.type].filter(Boolean).join(' ');

/** "TF3RPB Bláfjöll · 2 m FM": how a station is named everywhere in the app. */
export function stationLabel(station) {
  const who = [station.callsign, station.name].filter(Boolean).join(' ');
  const kind = stationKind(station);
  return kind ? `${who} · ${kind}` : who;
}

const mhz = (value) => value.toFixed(3);

/** How to work a station, as labelled pieces: Listen, Transmit, Tone (or Code). Empty when no frequency is known. */
export function stationFrequencyParts(station) {
  const parts = [];
  if (station.outputMHz !== null) parts.push({ label: t('freq.listen'), value: `${mhz(station.outputMHz)} MHz` });
  if (station.inputMHz !== null) {
    let shift = '';
    if (station.outputMHz !== null) {
      const delta = Math.round((station.inputMHz - station.outputMHz) * 1000) / 1000;
      if (delta !== 0) shift = ` (${delta > 0 ? '+' : '−'}${Math.abs(delta)})`;
    }
    parts.push({ label: t('freq.transmit'), value: `${mhz(station.inputMHz)} MHz${shift}` });
  }
  if (station.tone) parts.push({ label: t(/^\d/.test(station.tone) ? 'freq.tone' : 'freq.code'), value: station.tone });
  return parts;
}

/** The same in one line: "Listen 145.650 MHz · transmit 145.050 MHz (−0.6) · tone 88.5". */
export function stationFrequencies(station) {
  const text = stationFrequencyParts(station)
    .map((part) => `${part.label.toLowerCase()} ${part.value}`)
    .join(' · ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** The app's band (from js/settings.js) nearest to the station's frequency, and whether it is a close match. */
export function stationBand(station) {
  const frequency = station.inputMHz ?? station.outputMHz;
  if (frequency === null) return { band: '2m', exact: true, frequency: null };
  let best = null;
  for (const [id, band] of Object.entries(BANDS)) {
    const distance = Math.abs(Math.log(frequency / band.freqMHz));
    if (!best || distance < best.distance) best = { id, distance };
  }
  return { band: best.id, exact: best.distance < 0.03, frequency };
}

/**
 * The settings as they are once one end of the link is put on a station: the band follows the
 * station, the two ends become different stations, and that end takes the station's power,
 * antenna gain, cable loss and height. The settings given are left as they were.
 * @param {object} settings the app's settings (see js/settings.js)
 * @param {object} station one station from readStations
 * @param {0 | 1} index 0 for point A, 1 for point B
 */
export function settingsWithStation(settings, station, index) {
  let s = structuredClone(settings);
  const { band, exact, frequency } = stationBand(station);
  if (band !== s.band) {
    const previous = s;
    s = structuredClone(settingsForBand(band, previous));
    s.a.height = previous.a.height;
    s.b.height = previous.b.height;
  }
  // From here on the two ends are different stations. The other end starts as whatever both ends were.
  if (!s.split) s = { ...mirrorStations(s), split: true };
  const end = index === 0 ? 'a' : 'b';
  const letter = index === 0 ? 'A' : 'B';
  if (RADIOS.repeater.bands.includes(band)) s[end].radio = 'repeater';
  // An antenna from the list if one has this gain; otherwise the collinear, with the gain typed over it.
  const listed = antennasFor(band).find(([, a]) => a.gain === station.gainDbi);
  if (listed) s[end].antenna = listed[0];
  else if (ANTENNAS.collinear.bands.includes(band)) s[end].antenna = 'collinear';
  s[end].height = station.heightM;
  const set = (name, value, usual) => {
    if (value === usual) delete s.overrides[name];
    else s.overrides[name] = value;
  };
  set(`power${letter}`, station.powerW, RADIOS[s[end].radio].powerW);
  set(`gain${letter}`, station.gainDbi, ANTENNAS[s[end].antenna].gain);
  set(`cable${letter}`, station.cableDb, 0);
  delete s.overrides[`sens${letter}`];
  // A station on a frequency none of the bands is made for: use its own frequency.
  if (!exact && frequency !== null) s.overrides.freqMHz = frequency;
  else if (band !== settings.band) delete s.overrides.freqMHz;
  return s;
}

/** The layers that have something to show, in the order they first appear: [{ id, name, stations }]. */
export function stationLayers(stations) {
  const layers = new Map();
  for (const station of stations) {
    if (!layers.has(station.layer)) layers.set(station.layer, { id: station.layer, name: layerName(station.layer), stations: [] });
    layers.get(station.layer).stations.push(station);
  }
  return [...layers.values()];
}
