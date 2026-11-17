// Station layers: reads data/stations.csv (repeaters and other fixed stations)
// and turns each line into something the map can show and the radio part can
// use. No page elements in here, so it can be tested on its own.
//
// The sheet is meant to be edited by hand, in a spreadsheet, so the reading is
// forgiving: commas or semicolons between columns, decimal commas, any column
// order, and a byte-order mark at the start are all accepted.

import { BANDS } from './settings.js';

// The tick-box name for each layer. A layer that is not listed here still
// works; it is named after the word in the sheet's "layer" column.
export const LAYER_NAMES = {
  ira: 'ÍRA repeaters',
  'ira-aprs': 'ÍRA APRS',
  f4x4: '4x4 club repeaters',
  sar: 'SAR repeaters',
  meshcore: 'MeshCore repeaters',
};

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
  if (station.outputMHz !== null) parts.push({ label: 'Listen', value: `${mhz(station.outputMHz)} MHz` });
  if (station.inputMHz !== null) {
    let shift = '';
    if (station.outputMHz !== null) {
      const delta = Math.round((station.inputMHz - station.outputMHz) * 1000) / 1000;
      if (delta !== 0) shift = ` (${delta > 0 ? '+' : '−'}${Math.abs(delta)})`;
    }
    parts.push({ label: 'Transmit', value: `${mhz(station.inputMHz)} MHz${shift}` });
  }
  if (station.tone) parts.push({ label: /^\d/.test(station.tone) ? 'Tone' : 'Code', value: station.tone });
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

/** The layers that have something to show, in the order they first appear: [{ id, name, stations }]. */
export function stationLayers(stations) {
  const layers = new Map();
  for (const station of stations) {
    if (!layers.has(station.layer)) layers.set(station.layer, { id: station.layer, name: LAYER_NAMES[station.layer] ?? station.layer, stations: [] });
    layers.get(station.layer).stations.push(station);
  }
  return [...layers.values()];
}
