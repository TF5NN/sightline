// The page itself: the map, the two waypoints, the station choices, and the
// order things happen in.
//
// The opening view is deliberately bare: map, terrain profile and the line of
// sight, with ground above the line drawn in red. "Estimate radio link" opens
// the radio part: band, radio and antenna lists, and the link verdict.
//
// When both points are placed it:
//   1. draws a draft from the 10 m data,
//   2. decides where 2 m data would change the answer (near both antennas and
//      wherever the ground comes close to a narrow Fresnel zone),
//   3. loads just those stretches (asking first if the download is large).
// Changing a setting redoes the sums at once and only downloads more terrain
// if the new settings need stretches that were not loaded before.
//
// L (Leaflet), GeoTIFF and Plotly are loaded by index.html before this file.

import { clearProfile, drawProfile, isCompact } from './chart.js';
import { geodesicDistance, pointAlong } from './geo.js';
import { seaLevelOffset } from './geoid.js';
import {
  FROM_10M,
  FROM_2M,
  FROM_FILL,
  buildProfile,
  composeTrack,
  detailSpacing,
  fillGaps,
  heightRange,
  stretchSamples,
} from './profile.js';
import {
  STATUS_BLOCKED,
  STATUS_GRAZING,
  dbmToWatts,
  detailStretches,
  linkEstimate,
  mergeStretches,
  subtractStretches,
  wattsToDbm,
} from './radio.js';
import {
  ANTENNAS,
  BANDS,
  RADIOS,
  antennasFor,
  defaultSettings,
  bandStart,
  mirrorStations,
  radiosFor,
  resolveRadio,
  settingsForBand,
  settingsFromAddress,
  settingsToAddress,
  validOverride,
} from './settings.js';
import {
  readStations,
  stationBand,
  stationFrequencies,
  stationFrequencyParts,
  stationKind,
  stationLabel,
  settingsWithStation,
  stationLayers,
} from './stations.js';
import { createLookAround } from './lookaround.js';
import { LAYERS_URL, SAME_SPOT, bestOf, estimateLink, estimateWords, openLayers } from './sight.js';
import { ownDraft } from './owndraft.js';
import { createTerrain } from './terrain.js';

const { L, GeoTIFF, Plotly } = globalThis;

// --- fixed choices -----------------------------------------------------------

const START_VIEW = { centre: [64.9, -18.6], zoom: 6 }; // Iceland
const DRAFT_MAX_SAMPLES = 4000;
// 2 m detail loads on its own when the download is smaller than this. Above it
// the app asks first, so nobody burns mobile data by accident.
const AUTO_DETAIL_BYTES = 15_000_000;
// After the first round of 2 m data, the answer can shift enough to make a
// new stretch "close". Look again this many times at most.
const DETAIL_PASSES = 3;
const LABELS = ['A', 'B'];

// --- page elements ---------------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
  hint: $('hint'),
  stationsLine: $('stations-line'),
  sightLine: $('sight-line'),
  chart: $('chart'),
  readout: $('readout'),
  legend: $('legend'),
  legendFresnel: $('legend-fresnel'),
  legendGrazing: $('legend-grazing'),
  bareControls: $('bare-controls'),
  linkToggle: $('link-toggle'),
  linkPanel: $('link-panel'),
  linkNote: $('link-note'),
  verdictBox: $('verdict-box'),
  status: $('status'),
  loadDetail: $('load-detail'),
  locate: $('locate'),
  swap: $('swap'),
  clear: $('clear'),
  look: $('look'),
  lookDialog: $('look-dialog'),
  lookView: $('look-view'),
  lookFacing: $('look-facing'),
  lookNearest: $('look-nearest'),
  lookClose: $('look-close'),
  share: $('share'),
  about: $('about'),
  aboutOpen: $('about-open'),
  powerUnit: $('power-unit'),
  sensNote: $('sens-note'),
};
// Number boxes under Advanced, and the hand-typed figure ("override") each one sets.
const OVERRIDE_FIELDS = {
  freq: 'freqMHz',
  'gain-a': 'gainA',
  'gain-b': 'gainB',
  'cable-a': 'cableA',
  'cable-b': 'cableB',
  'sens-a': 'sensA',
  'sens-b': 'sensB',
};
const POWER_FIELDS = { 'power-a': 'powerA', 'power-b': 'powerB' };

// --- state -------------------------------------------------------------------

// For development: ?terrain=http://localhost:8081 reads tiles from another address.
const terrainOverride = new URLSearchParams(location.search).get('terrain');
const terrain = createTerrain(terrainOverride ? { GeoTIFF, baseUrl: terrainOverride } : { GeoTIFF });

const state = {
  waypoints: [], // { lat, lon }, at most two for now
  settings: defaultSettings(),
  run: 0, // goes up every time something changes, so old downloads can be ignored
  controller: null,
  draft: null, // the 10 m profile of the current path
  stretches: [], // 2 m stretches loaded so far for the current path
  approved: false, // has the user said yes to a large 2 m download for this path?
  shown: null, // what is on screen: { track, ground, link }
  pending: false,
  stations: [], // from data/stations.csv, once it has loaded
  layersOn: new Set(), // ids of the station layers showing on the map
  layersWanted: [], // layer ids named in the page address, switched on once the sheet has loaded
};

// --- map ---------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView(START_VIEW.centre, START_VIEW.zoom);
// Two backgrounds to choose from with the layers button in the corner of the map.
const backgrounds = {
  map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
  // Sentinel-2 satellite pictures, 10 m detail, free for non-commercial use with this credit.
  sat: L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg', {
    maxZoom: 19,
    maxNativeZoom: 14, // the pictures stop here; closer in they are enlarged
    attribution:
      '<a href="https://cloudless.eox.at">EOxCloudless</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2024)',
  }),
};
let background = 'map';
backgrounds.map.addTo(map);
const layersControl = L.control.layers({ Map: backgrounds.map, Satellite: backgrounds.sat }, null, { position: 'topright' }).addTo(map);
function showBackground(name) {
  background = backgrounds[name] ? name : 'map';
  for (const [key, layer] of Object.entries(backgrounds)) {
    if (key === background) layer.addTo(map);
    else layer.remove();
  }
}
map.on('baselayerchange', (event) => {
  background = event.layer === backgrounds.sat ? 'sat' : 'map';
  writeAddress();
});

const markers = [];
// A white edge under the path keeps it readable on the satellite picture.
const pathEdge = L.polyline([], { color: '#ffffff', weight: 6, opacity: 0.75, interactive: false }).addTo(map);
const pathLine = L.polyline([], { color: '#2f6fb7', className: 'map-path', weight: 3, opacity: 0.9 }).addTo(map);
const problemLines = L.layerGroup().addTo(map);
const hoverDot = L.circleMarker([0, 0], {
  radius: 6,
  color: '#ffffff',
  weight: 2,
  fillColor: '#203b3d',
  className: 'map-hover',
  fillOpacity: 1,
  interactive: false,
});

function pinIcon(label) {
  return L.divIcon({
    className: '',
    html: `<div class="pin"><span>${label}</span></div>`,
    iconSize: [34, 34], // big enough to grab with a thumb
    iconAnchor: [17, 34],
  });
}

function drawPath() {
  if (state.waypoints.length < 2) {
    pathLine.setLatLngs([]);
    pathEdge.setLatLngs([]);
    return;
  }
  const [a, b] = state.waypoints;
  const steps = 32; // enough to show the slight curve of a long path
  const line = [];
  for (let i = 0; i <= steps; i++) {
    const p = pointAlong(a, b, i / steps);
    line.push([p.lat, p.lon]);
  }
  pathLine.setLatLngs(line);
  pathEdge.setLatLngs(line);
}

/**
 * Colour the problem stretches of the path on the map: red where the ground is
 * above the line of sight, and (with the radio link part open) amber where it
 * comes inside 60% of the Fresnel zone.
 */
function drawProblemsOnMap(track, status, showGrazing) {
  problemLines.clearLayers();
  let current = null; // { kind, points }
  const finish = () => {
    if (current && current.points.length > 1) {
      L.polyline(current.points, {
        color: current.kind === STATUS_BLOCKED ? '#c0392b' : '#d98a00',
        className: current.kind === STATUS_BLOCKED ? 'map-bad' : 'map-marginal',
        weight: 6,
        opacity: 0.95,
        interactive: false,
      }).addTo(problemLines);
    }
    current = null;
  };
  for (let i = 0; i < status.length; i++) {
    const kind = status[i];
    if (kind !== STATUS_BLOCKED && !(showGrazing && kind === STATUS_GRAZING)) {
      finish();
      continue;
    }
    if (!current || current.kind !== kind) {
      finish();
      current = { kind, points: i > 0 ? [[track.lat[i - 1], track.lon[i - 1]]] : [] };
    }
    current.points.push([track.lat[i], track.lon[i]]);
  }
  finish();
}

function syncMarkers() {
  while (markers.length > state.waypoints.length) markers.pop().remove();
  state.waypoints.forEach((wp, index) => {
    if (!markers[index]) {
      const marker = L.marker([wp.lat, wp.lon], { draggable: true, icon: pinIcon(LABELS[index]) }).addTo(map);
      marker.on('drag', () => {
        const pos = marker.getLatLng();
        // A pin that is dragged away is no longer on the station it was put on.
        state.waypoints[index] = { lat: pos.lat, lon: pos.lng };
        drawPath();
      });
      marker.on('dragstart', () => problemLines.clearLayers());
      marker.on('dragend', () => pathChanged());
      markers[index] = marker;
    } else {
      markers[index].setLatLng([wp.lat, wp.lon]);
    }
  });
  drawPath();
}

map.on('click', (event) => {
  if (state.waypoints.length >= 2) {
    setStatus('Both points are placed. Drag one to move it, or press Clear to start again.');
    return;
  }
  state.waypoints.push({ lat: event.latlng.lat, lon: event.latlng.lng });
  pathChanged();
});

// --- station layers (repeaters and other fixed stations from data/stations.csv) ---

const stationGroups = new Map(); // layer id -> the Leaflet group holding its markers
const stationById = (id) => state.stations.find((s) => s.id.toLowerCase() === String(id).toLowerCase());

/** A station's marker. `verdict` colours it by whether it can be worked from point A: 'good', 'marginal' or 'unlikely'. */
function stationIcon(verdict = '') {
  return L.divIcon({
    className: '',
    html: `<div class="station-dot${verdict ? ` sight-${verdict}` : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v11M8 20l4-11 4 11M9.2 16.5h5.6"/><path d="M8.2 6.8a5.4 5.4 0 0 1 7.6 0M5.6 4.2a9 9 0 0 1 12.8 0"/></svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12],
  });
}

/** One line of a station's details: a small label and its value. */
function detailLine(label, value, note = '') {
  const line = document.createElement('p');
  line.className = 'detail';
  const key = document.createElement('span');
  key.className = 'k';
  key.textContent = label;
  const text = document.createElement('span');
  text.textContent = value;
  if (note) {
    const small = document.createElement('span');
    small.className = 'assumed';
    small.textContent = ` ${note}`;
    text.append(small);
  }
  line.append(key, text);
  return line;
}

/** What a tap on a site shows: every station there, one card each. */
function sitePopup(stations) {
  const box = document.createElement('div');
  box.className = 'station-popup';
  box.append(...stations.map(stationCard));
  return box;
}

/** One station: who it is, how to work it, and the buttons to use it as a point. */
function stationCard(station) {
  const box = document.createElement('div');
  box.className = 'station-card';
  const title = document.createElement('h3');
  title.textContent = [station.callsign, station.name].filter(Boolean).join(' ');
  const kind = document.createElement('p');
  kind.className = 'kind';
  kind.textContent = [stationKind(station), station.status].filter(Boolean).join(' · ');
  box.append(title, kind);
  const seen = sightFromA.stations.get(station.id);
  if (seen) {
    const line = document.createElement('p');
    line.className = `sight sight-${seen.kind}`;
    line.textContent = estimateWords(seen);
    box.append(line);
  }

  const frequencies = stationFrequencyParts(station);
  if (frequencies.length) {
    // What to put in the radio, one figure per line.
    const dial = document.createElement('div');
    dial.className = 'freq';
    dial.append(...frequencies.map((part) => detailLine(part.label, part.value)));
    box.append(dial);
  }
  const guess = (key) => (station.assumed.includes(key) ? '(assumed)' : '');
  box.append(
    detailLine('Power', `${station.powerW} W`, guess('powerW')),
    detailLine('Antenna', `${station.antenna ? `${station.antenna}, ` : ''}${station.gainDbi} dBi`, guess('gainDbi')),
    detailLine('Height', `${station.heightM} m above ground`, guess('heightM')),
  );
  if (station.confidence) box.append(detailLine('Position', `${station.confidence} confidence`));
  if (station.notes) {
    const notes = document.createElement('p');
    notes.className = 'notes';
    notes.textContent = station.notes;
    box.append(notes);
  }

  const buttons = document.createElement('p');
  buttons.className = 'use';
  // Point B only makes sense once there is a point A.
  const ends = state.waypoints.length === 0 ? [0] : [0, 1];
  for (const index of ends) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Use as ${LABELS[index]}`;
    button.dataset.end = LABELS[index].toLowerCase();
    button.addEventListener('click', () => {
      map.closePopup();
      useStation(station, index);
    });
    buttons.append(button);
  }
  box.append(buttons);
  return box;
}

/** Put point A or B on a station and fill in that end of the link from what the sheet says about it. */
function useStation(station, index) {
  state.waypoints[index] = { lat: station.lat, lon: station.lon, station: station.id };

  state.settings = settingsWithStation(state.settings, station, index);
  showSettings();
  pathChanged();
}

/** Under the hint: which stations the two points are on, and how to work them. */
function showStationsLine() {
  const lines = [];
  state.waypoints.forEach((wp, index) => {
    const station = wp.station && stationById(wp.station);
    if (!station) return;
    const frequencies = stationFrequencies(station);
    lines.push(`${LABELS[index]}: ${stationLabel(station)}${frequencies ? `. ${frequencies}.` : ''}`);
  });
  el.stationsLine.hidden = lines.length === 0;
  el.stationsLine.replaceChildren(
    ...lines.map((text) => {
      const line = document.createElement('span');
      line.textContent = text;
      return line;
    }),
  );
}

// --- which stations can be seen from point A (a first look, Iceland only) ------

// For development and the checks: ?horizon=http://localhost:8082/v1/ reads the terrain layers from another address.
const layersUrl = new URLSearchParams(location.search).get('horizon') ?? LAYERS_URL;
// For comparing the two sources of the draft: ?draft=arcticdem reads it from ArcticDEM even in Iceland.
const draftSource = new URLSearchParams(location.search).get('draft');
const siteKey = (station) => `${station.lat},${station.lon}`;
const sites = []; // every marker on the station layers: { layer, marker, stations }
const sightFromA = {
  key: '', // what the results on screen were worked out for
  results: new Map(), // site key -> the best link estimate among the stations there
  stations: new Map(), // station id -> its own link estimate
};

/**
 * The link from A to each station at one site, estimated on a coarse terrain profile.
 * Gives null when the site is where A is, or when either is outside the terrain layers.
 */
async function estimateSite(layers, a, site) {
  const [station] = site.stations;
  if (geodesicDistance(a, station) < SAME_SPOT) return null; // A is on this station
  const profile = await layers.profile({ from: { lat: a.lat, lon: a.lon }, to: { lat: station.lat, lon: station.lon } });
  if (!profile) return null; // outside Iceland, or at sea
  return site.stations.map((s) => estimateLink(profile, s, state.settings));
}

/**
 * Colour the stations on the layers that are showing by whether they can be worked from point A.
 * Runs again only when A, the settings or the layers showing have changed.
 */
async function refreshSight() {
  const a = state.waypoints[0];
  const shown = sites.filter((site) => state.layersOn.has(site.layer));
  const key = a && shown.length ? `${a.lat},${a.lon},${[...state.layersOn].sort()},${JSON.stringify(state.settings)}` : '';
  if (key === sightFromA.key) return;
  sightFromA.key = key;
  sightFromA.results.clear();
  sightFromA.stations.clear();
  for (const site of sites) site.marker.setIcon(stationIcon());
  el.sightLine.hidden = true;
  if (!key) return;
  try {
    const layers = await openLayers(layersUrl);
    for (const site of shown) {
      const estimates = await estimateSite(layers, a, site);
      if (key !== sightFromA.key) return; // A has moved on meanwhile
      if (!estimates) continue;
      const best = bestOf(estimates);
      sightFromA.results.set(siteKey(site.stations[0]), best);
      site.stations.forEach((station, i) => sightFromA.stations.set(station.id, estimates[i]));
      site.marker.setIcon(stationIcon(best.kind));
      el.sightLine.hidden = false;
    }
  } catch (error) {
    // The app works without this; the stations just keep their plain look.
    console.warn('Could not estimate which stations can be worked', error);
  }
}

// --- look around from point A (Iceland only) -----------------------------------

const lookAround = createLookAround(el.lookView, el.lookFacing);

/** Open the view from A: the skyline, with the stations on the layers that are showing, and point B, marked on it. */
async function openLookAround() {
  const [a, b] = state.waypoints;
  if (!a) return;
  const words = el.look.textContent;
  el.look.disabled = true;
  el.look.textContent = 'Reading terrain…';
  try {
    const layers = await openLayers(layersUrl);
    if (!(await layers.covers(a.lat, a.lon))) {
      setStatus('Look around works on land in Iceland only, and point A is outside it.', true);
      return;
    }
    const from = { lat: a.lat, lon: a.lon, antennaMetres: state.settings.a.height };
    // closeDetail: the closest 500 m from the 10 m data, with the ground counted from 10 m out, as
    // in Northbound. Without it the nearest 100 m is left out, and on a hilltop or slope the
    // hillside beside the point, which is the real skyline there, goes missing.
    const horizon = await layers.horizon({ ...from, closeDetail: true });
    el.lookNearest.textContent = String(horizon.nearestMetres ?? 100);
    const marks = [];
    for (const site of sites.filter((s) => state.layersOn.has(s.layer))) {
      const estimates = await estimateSite(layers, a, site);
      if (!estimates) continue;
      const best = bestOf(estimates);
      const label = [...new Set(site.stations.map((s) => s.callsign || s.name))].join(' / ');
      marks.push({ az: best.bearingDegrees, el: best.angleDegrees, label, kind: best.kind });
    }
    let yaw = marks.find((mark) => mark.kind === 'good')?.az ?? 0;
    if (b && geodesicDistance(a, b) >= SAME_SPOT) {
      const seen = await layers.sight({ from, to: { lat: b.lat, lon: b.lon, antennaMetres: state.settings.b.height } });
      if (seen) {
        marks.push({ az: seen.bearingDegrees, el: seen.angleDegrees, label: 'B', kind: 'b' });
        yaw = seen.bearingDegrees;
      }
    }
    lookAround.show(horizon, marks, yaw);
    el.lookDialog.showModal();
  } catch (error) {
    console.warn('Could not open the look-around view', error);
    setStatus('The terrain for the look-around view could not be loaded. Check the connection and try again.', true);
  } finally {
    el.look.textContent = words;
    el.look.disabled = state.waypoints.length === 0;
  }
}
el.look.addEventListener('click', openLookAround);
el.lookClose.addEventListener('click', () => el.lookDialog.close());

/** Switch on the station layers with these ids (once the sheet has loaded). */
function showLayers(ids) {
  for (const [id, group] of stationGroups) {
    if (ids.includes(id)) group.addTo(map);
    else group.remove();
  }
}

async function loadStations() {
  try {
    const response = await fetch('data/stations.csv', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { stations, problems } = readStations(await response.text());
    for (const problem of problems) console.warn('Stations sheet:', problem);
    state.stations = stations;
    for (const layer of stationLayers(stations)) {
      const group = L.layerGroup();
      // Stations at the very same spot (two repeaters on one mast) share a marker, or only the top one could be tapped.
      const spots = new Map();
      for (const station of layer.stations) {
        const key = siteKey(station);
        if (!spots.has(key)) spots.set(key, []);
        spots.get(key).push(station);
      }
      for (const here of spots.values()) {
        const marker = L.marker([here[0].lat, here[0].lon], { icon: stationIcon(), title: here.map(stationLabel).join(' / '), keyboard: true });
        marker.on('click', () => {
          // Sized to the map as it is now, and kept clear of the buttons in its corners; long details scroll.
          const size = map.getSize();
          L.popup({
            minWidth: Math.min(220, size.x - 112),
            maxWidth: Math.min(300, size.x - 112), // the map's width less the zoom buttons and the popup's own edges
            maxHeight: Math.max(150, size.y - 110),
            autoPanPaddingTopLeft: [54, 58],
            autoPanPaddingBottomRight: [10, 26],
            offset: [0, -10],
          })
            .setLatLng(marker.getLatLng())
            .setContent(sitePopup(here))
            .openOn(map);
        });
        marker.addTo(group);
        sites.push({ layer: layer.id, marker, stations: here });
      }
      stationGroups.set(layer.id, group);
      layersControl.addOverlay(group, layer.name);
    }
    showLayers(state.layersWanted);
    showStationsLine();
  } catch (error) {
    // The app works without the sheet; there are just no station layers to switch on.
    console.warn('Could not load the stations sheet', error);
  }
}

map.on('overlayadd overlayremove', () => {
  state.layersOn = new Set([...stationGroups].filter(([, group]) => map.hasLayer(group)).map(([id]) => id));
  writeAddress();
  refreshSight();
});

// --- page address (so a setup can be shared as a link) -----------------------

function writeAddress() {
  const parts = state.waypoints.map(
    (wp, i) => `${LABELS[i].toLowerCase()}=${wp.lat.toFixed(5)},${wp.lon.toFixed(5)}`,
  );
  state.waypoints.forEach((wp, i) => {
    if (wp.station) parts.push(`s${LABELS[i].toLowerCase()}=${encodeURIComponent(wp.station)}`);
  });
  parts.push(...settingsToAddress(state.settings));
  if (background !== 'map') parts.push(`bg=${background}`);
  const layers = state.stations.length ? [...state.layersOn] : state.layersWanted;
  if (layers.length) parts.push(`layers=${layers.map(encodeURIComponent).join(',')}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function readAddress() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const waypoints = [];
  for (const label of LABELS) {
    const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(params.get(label.toLowerCase()) ?? '');
    if (!match) break;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) break;
    const station = params.get(`s${label.toLowerCase()}`);
    waypoints.push(station ? { lat, lon, station } : { lat, lon });
  }
  return {
    waypoints,
    settings: settingsFromAddress(params),
    background: params.get('bg') ?? 'map',
    layers: (params.get('layers') ?? '').split(',').filter(Boolean),
  };
}

// --- small helpers -------------------------------------------------------------

function setStatus(text, problem = false) {
  el.status.textContent = text;
  el.status.classList.toggle('problem', problem);
}

const fmtDistance = (m) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
const fmtHeight = (h) => (Number.isFinite(h) ? `${Math.round(h)} m` : 'no data');
const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;
const fmtDb = (db) => `${db.toFixed(1)} dB`;
const signed = (n, digits = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`;
const isCancel = (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''));
const SOURCE_WORDS = { [FROM_10M]: '10 m data', [FROM_2M]: '2 m data', [FROM_FILL]: 'filled from coarser data' };

const radioFromSettings = () => resolveRadio(state.settings);

// --- drawing the result ----------------------------------------------------------

/** Work everything out from the terrain loaded so far and put it on screen. */
function render() {
  const track = composeTrack(state.draft, state.stretches);
  const n = track.distance.length;
  // Heights above sea level (the files hold heights above the ellipsoid).
  const ground = new Float32Array(n);
  for (let i = 0; i < n; i++) ground[i] = track.height[i] - seaLevelOffset(track.lat[i], track.lon[i]);

  const km = Array.from(track.distance, (d) => d / 1000);
  const endsKnown = Number.isFinite(ground[0]) && Number.isFinite(ground[n - 1]);
  const link = endsKnown ? linkEstimate({ distances: track.distance, ground, radio: radioFromSettings() }) : null;
  state.shown = { track, ground, link };

  const linkOpen = state.settings.linkOpen;
  const showFresnel = linkOpen && state.settings.fresnel;
  el.chart.hidden = false;
  el.readout.hidden = false;
  el.legend.hidden = !link;
  el.legendFresnel.hidden = !showFresnel;
  el.legendGrazing.hidden = !linkOpen;
  el.bareControls.hidden = false;

  const view = link
    ? {
        km,
        terrain: link.path.terrain,
        los: link.path.los,
        fresnel: link.path.fresnel,
        status: link.path.status,
        showFresnel,
        showGrazing: linkOpen,
        // The loss labels on the ridges belong with the Fresnel zone: detail for those who ask for it.
        edges: showFresnel
          ? link.diffraction.edges.map((e) => ({ km: e.distance / 1000, height: e.height, loss: e.loss }))
          : [],
        masts: { baseA: ground[0], tipA: link.path.tipA, baseB: ground[n - 1], tipB: link.path.tipB },
      }
    : { km, terrain: ground };

  idleReadout();
  state.compact = isCompact(el.chart);
  drawProfile(Plotly, el.chart, view, {
    onHover: (index) => {
      if (index >= n) return;
      el.readout.classList.remove('idle');
      hoverDot.setLatLng([track.lat[index], track.lon[index]]).addTo(map);
      let text = `${fmtDistance(track.distance[index])} from A · ground ${fmtHeight(ground[index])}`;
      if (link && index > 0 && index < n - 1 && Number.isFinite(ground[index])) {
        const c = link.path.clearance[index];
        text += c >= 0 ? ` · ${c.toFixed(0)} m below the line of sight` : ` · ${(-c).toFixed(0)} m above the line of sight`;
        if (showFresnel && c >= 0 && link.path.fresnel[index] > 0) {
          text += ` (${((c / link.path.fresnel[index]) * 100).toFixed(0)}% of the Fresnel radius)`;
        }
      }
      if (SOURCE_WORDS[track.source[index]]) text += ` · ${SOURCE_WORDS[track.source[index]]}`;
      el.readout.textContent = text;
    },
    onLeave: () => {
      hoverDot.remove();
      idleReadout();
    },
  });

  if (link) drawProblemsOnMap(track, link.path.status, linkOpen);
  else problemLines.clearLayers();
  showLinkResults();
}

const fingers = globalThis.matchMedia?.('(pointer: coarse)').matches;
/** Nothing is being read off the profile: say how to. */
function idleReadout() {
  el.readout.classList.add('idle');
  el.readout.textContent = fingers
    ? 'Slide a finger along the profile to read the heights.'
    : 'Move the pointer along the profile to read the heights.';
}

/** Fill in the radio link panel (it may be closed; the numbers are kept ready either way). */
function showLinkResults() {
  const shown = state.shown;
  el.verdictBox.className = 'verdict-box';
  const blank = () => {
    for (const id of ['r-verdict', 'r-margin', 'r-received', 'r-fsl', 'r-diffraction', 'r-distance']) $(id).textContent = '–';
    el.linkNote.textContent = '';
  };
  if (!shown) {
    blank();
    el.linkNote.textContent = 'Place two points on the map to get an estimate.';
    return;
  }
  const { track, link } = shown;
  if (!link) {
    blank();
    $('r-distance').textContent = fmtDistance(track.total);
    return;
  }
  $('r-distance').textContent = fmtDistance(track.total);
  $('r-verdict').textContent = link.verdict.word;
  el.verdictBox.classList.add(link.verdict.key);
  $('r-margin').textContent = `${signed(link.margin)} dB`;
  $('r-received').textContent = `${signed(link.received)} dBm`;
  $('r-fsl').textContent = fmtDb(link.freeSpaceLoss);
  const edges = link.diffraction.edges.length;
  $('r-diffraction').textContent =
    link.terrainLoss === 0
      ? 'none'
      : link.terrainMethod === 'edges'
        ? `${fmtDb(link.terrainLoss)}, ${edges} edge${edges > 1 ? 's' : ''}`
        : fmtDb(link.terrainLoss);

  const notes = [];
  if (link.oneWay) {
    notes.push(`One way only, ${link.oneWay === 'aToB' ? 'A to B' : 'B to A'}: the other end only receives.`);
  }
  if (link.twoWayDiffers) {
    const [weak, other] = link.weaker === 'aToB' ? ['A to B', link.bToA] : ['B to A', link.aToB];
    notes.push(`Judged on the weaker direction, ${weak}. The other way has ${fmtDb(other.margin - link.margin)} more to spare.`);
  }
  if (link.terrainMethod === 'allowance') {
    const b = link.bullington;
    notes.push(`Terrain loss is ${fmtDb(b.knifeEdge)} over the ridge plus ${fmtDb(b.allowance)} allowance for broad, real terrain.`);
  }
  el.linkNote.textContent = notes.join(' ');
}

function hideProfile() {
  state.shown = null;
  el.chart.hidden = true;
  el.readout.hidden = true;
  el.legend.hidden = true;
  el.bareControls.hidden = true;
  el.readout.textContent = '';
  el.loadDetail.hidden = true;
  hoverDot.remove();
  problemLines.clearLayers();
  clearProfile(Plotly, el.chart);
  showLinkResults();
}

function explainNoData(problems) {
  if (problems.blocked > 0) {
    return 'Could not reach the terrain data. Check your connection and try again. If it keeps happening, run the data connection test linked at the bottom of the page.';
  }
  return 'No terrain data on this path. ArcticDEM covers land north of about 60°N.';
}

function dataSummary() {
  const { track } = state.shown;
  const count = (code) => track.source.reduce((sum, s) => sum + (s === code ? 1 : 0), 0);
  const fine = count(FROM_2M);
  const filled = count(FROM_FILL);
  const covered = mergeStretches(state.stretches.map((s) => [s.from, s.to])).reduce((sum, [f, t]) => sum + (t - f), 0);
  let text = `${track.distance.length.toLocaleString('en')} samples`;
  if (fine > 0) text += `, 2 m data on ${fmtDistance(covered)} of the path`;
  else text += ', 10 m data';
  if (filled > 0) text += `, ${filled.toLocaleString('en')} filled from coarser data`;
  return text;
}

// --- the main sequence -----------------------------------------------------------

/** The waypoints changed: forget the old terrain and start over. */
function pathChanged() {
  syncMarkers();
  showStationsLine();
  el.swap.disabled = state.waypoints.length < 2;
  el.clear.disabled = state.waypoints.length === 0;
  el.look.disabled = state.waypoints.length === 0;
  el.hint.hidden = state.waypoints.length >= 2;
  if (state.waypoints.length === 1) el.hint.textContent = 'Now tap the map to place point B.';
  if (state.waypoints.length === 0) {
    el.hint.textContent = 'Tap the map to place point A, then point B. Drag a point to move it.';
  }
  state.draft = null;
  state.stretches = [];
  state.approved = false;
  hideProfile();
  return update();
}

/** Something changed (waypoints or settings): bring the screen up to date. */
async function update() {
  writeAddress();
  refreshSight();
  // Anything still downloading for the old situation is no longer wanted.
  state.controller?.abort();
  state.run += 1;
  state.pending = false;
  el.loadDetail.hidden = true;
  if (state.waypoints.length < 2) {
    setStatus('');
    return;
  }

  const run = state.run;
  const controller = new AbortController();
  state.controller = controller;
  const [a, b] = state.waypoints;
  const stillCurrent = () => run === state.run;

  if (geodesicDistance(a, b) < 20) {
    setStatus('The two points are almost on top of each other. Drag one of them further away.', true);
    return;
  }

  try {
    // 1. Draft from the 10 m layer (only when the path itself changed).
    if (!state.draft) {
      setStatus('Reading the 10 m draft…');
      // In Iceland the draft comes from the shared terrain layers: the same 10 m data in much
      // smaller pieces. Anywhere else, or if they cannot be reached, it is read from ArcticDEM.
      let draft = null;
      if (draftSource !== 'arcticdem') {
        try {
          draft = await ownDraft({ layers: await openLayers(layersUrl), a, b, maxSamples: DRAFT_MAX_SAMPLES });
        } catch (error) {
          console.warn('The terrain layers could not give the draft; reading ArcticDEM instead', error);
        }
        if (!stillCurrent()) return;
      }
      draft ??= await buildProfile({
        terrain,
        a,
        b,
        layerId: '10m',
        maxSamples: DRAFT_MAX_SAMPLES,
        signal: controller.signal,
      });
      if (!stillCurrent()) return;
      // Holes in the draft are filled from the 32 m layer.
      if (draft.coverage < 1) {
        const coarse = await buildProfile({
          terrain,
          a,
          b,
          layerId: '32m',
          maxSamples: DRAFT_MAX_SAMPLES,
          signal: controller.signal,
        });
        if (!stillCurrent()) return;
        fillGaps(draft, coarse);
        if (coarse.problems.blocked > 0) draft.problems.blocked += coarse.problems.blocked;
      }
      if (!heightRange(draft.heights)) {
        setStatus(explainNoData(draft.problems), true);
        return;
      }
      state.draft = draft;
    }
    render();
    if (!state.shown.link) {
      setStatus('There is no terrain data under one of the two points, so the link cannot be worked out.', true);
      return;
    }

    // 2 and 3. Load 2 m data where it matters, then look again.
    if (state.settings.detail === '10m') {
      setStatus(`Done, on 10 m data only. ${dataSummary()}.`);
      return;
    }
    for (let pass = 0; pass < DETAIL_PASSES; pass++) {
      const { track, link } = state.shown;
      const wanted =
        state.settings.detail === 'full'
          ? [[0, track.total]]
          : detailStretches({ distances: track.distance, path: link.path, diffraction: link.diffraction });
      const have = state.stretches.map((s) => [s.from, s.to]);
      const missing = subtractStretches(wanted, have);
      if (missing.length === 0) break;

      const spacing = detailSpacing(wanted, state.draft.heights.length, state.settings.maxSamples);
      const sets = missing.map(([from, to]) => stretchSamples(a, b, track.total, from, to, spacing));
      const grid = sets.flatMap((s) => s.grid);

      if (pass === 0) setStatus('Checking the size of the 2 m detail…');
      const cost = await terrain.estimate('2m', grid);
      if (!stillCurrent()) return;
      if (cost.blocks === 0) {
        setStatus(`Done. There is no 2 m data on this path. ${dataSummary()}.`);
        return;
      }
      if (cost.bytesToFetch > AUTO_DETAIL_BYTES && !state.approved) {
        const size = `about ${fmtMB(cost.bytesToFetch)}`;
        state.pending = true;
        el.loadDetail.textContent = `Load 2 m detail (${size})`;
        el.loadDetail.hidden = false;
        setStatus(`Showing the result so far. The 2 m detail for this path is a larger download: ${size}.`);
        return;
      }

      setStatus('Loading 2 m detail…');
      const result = await terrain.sample('2m', grid, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (stillCurrent()) setStatus(`Loading 2 m detail… ${done} of ${total} blocks`);
        },
      });
      if (!stillCurrent()) return;
      let offset = 0;
      for (const set of sets) {
        const count = set.distance.length;
        state.stretches.push({
          from: set.from,
          to: set.to,
          distance: set.distance,
          lat: set.lat,
          lon: set.lon,
          height: result.heights.subarray(offset, offset + count),
        });
        offset += count;
      }
      render();
    }
    setStatus(`Done. ${dataSummary()}.`);
  } catch (error) {
    if (isCancel(error) || !stillCurrent()) return;
    console.error(error);
    const what = state.draft ? 'The result so far is still shown.' : '';
    setStatus(`Something went wrong while reading the terrain: ${error.message ?? error}. ${what}`, true);
  }
}

// --- station choices -----------------------------------------------------------------

const roundTo = (n, digits) => String(Math.round(n * 10 ** digits) / 10 ** digits);

function fillSelect(select, entries, value) {
  select.replaceChildren(
    ...entries.map(([id, label]) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      return option;
    }),
  );
  select.value = value;
}

const antennaLabel = (a) => `${a.label} (${a.gain > 0 ? '+' : a.gain < 0 ? '−' : ''}${Math.abs(a.gain)} dBi)`;
const showPower = (watts) =>
  state.settings.powerUnit === 'W' ? roundTo(watts, 4) : watts > 0 ? roundTo(wattsToDbm(watts), 1) : '';

/** Put the current choices and their numbers on the page. */
function showSettings() {
  const s = state.settings;
  const radio = resolveRadio(s);

  $('height-a').value = roundTo(s.a.height, 2);
  $('height-b').value = roundTo(s.b.height, 2);

  el.linkPanel.hidden = !s.linkOpen;
  el.linkToggle.textContent = s.linkOpen ? 'Hide radio link' : 'Estimate radio link';
  el.linkToggle.setAttribute('aria-expanded', String(s.linkOpen));
  el.linkToggle.classList.toggle('primary', !s.linkOpen);

  fillSelect($('band'), Object.entries(BANDS).map(([id, b]) => [id, b.label]), s.band);
  const radios = radiosFor(s.band).map(([id, r]) => [id, r.label]);
  const antennas = antennasFor(s.band).map(([id, a]) => [id, antennaLabel(a)]);
  fillSelect($('radio-a'), radios, s.a.radio);
  fillSelect($('antenna-a'), antennas, s.a.antenna);
  fillSelect($('radio-b'), radios, s.b.radio);
  fillSelect($('antenna-b'), antennas, s.b.antenna);
  $('split').checked = s.split;
  $('fresnel').checked = s.fresnel;
  $('radio-a-label').textContent = s.split ? 'Radio at A' : 'Radio';
  $('antenna-a-label').textContent = s.split ? 'Antenna at A' : 'Antenna';
  for (const node of document.querySelectorAll('.split-only')) node.hidden = !s.split;
  for (const node of document.querySelectorAll('.a-word')) {
    const base = node.textContent.replace(/ at A$/, '');
    node.textContent = s.split ? `${base} at A` : base;
  }

  // Advanced: the figures in use, whether they came from the lists or were typed by hand.
  const values = {
    freq: roundTo(radio.freqMHz, 4),
    'gain-a': roundTo(radio.gainA, 2),
    'gain-b': roundTo(radio.gainB, 2),
    'cable-a': roundTo(radio.cableA, 2),
    'cable-b': roundTo(radio.cableB, 2),
    'sens-a': roundTo(radio.sensA, 1),
    'sens-b': roundTo(radio.sensB, 1),
    'power-a': showPower(radio.powerA),
    'power-b': showPower(radio.powerB),
    'max-samples': String(s.maxSamples),
    k: roundTo(s.k, 2),
  };
  for (const [id, value] of Object.entries(values)) {
    $(id).value = value;
    $(id).classList.remove('invalid');
  }
  el.powerUnit.value = s.powerUnit;
  $('detail').value = s.detail;
  const lora = Boolean(radio.lora);
  for (const node of document.querySelectorAll('.lora-only')) node.hidden = !lora;
  if (lora) {
    $('sf').value = String(radio.lora.sf);
    $('bw').value = String(radio.lora.bw);
  }
  $('sens-a').disabled = lora;
  $('sens-b').disabled = lora;
  el.sensNote.textContent = lora
    ? 'For LoRa the sensitivity is worked out from the spreading factor and bandwidth. Higher spreading factor or narrower bandwidth hears weaker signals, at the cost of slower messages.'
    : 'Sensitivity is the weakest signal the receiver can use: −119 dBm is typical for FM, and that is "just readable", not comfortable.';
}

let settingsTimer = null;
/** A setting changed: redo the sums shortly (so typing a number does not redo them per keystroke). */
function settingsChanged() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    if (state.draft) update();
    else writeAddress();
  }, 250);
}

function readNumber(input, isValid) {
  const value = Number(input.value);
  const ok = input.value.trim() !== '' && Number.isFinite(value) && isValid(value);
  input.classList.toggle('invalid', !ok);
  return ok ? value : null;
}

/** Forget hand-typed figures that a fresh choice from a list should replace. */
function dropOverrides(names) {
  for (const name of names) delete state.settings.overrides[name];
}

// Antenna heights: always visible, because the line of sight depends on them.
for (const [id, end] of [['height-a', 'a'], ['height-b', 'b']]) {
  $(id).addEventListener('input', () => {
    const value = readNumber($(id), (v) => v >= 0 && v <= 1000);
    if (value === null) return;
    state.settings[end].height = value;
    settingsChanged();
  });
}

el.linkToggle.addEventListener('click', () => {
  state.settings.linkOpen = !state.settings.linkOpen;
  showSettings();
  if (state.draft) render();
  writeAddress();
  if (state.settings.linkOpen) el.linkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('band').addEventListener('change', () => {
  const previous = state.settings;
  state.settings = settingsForBand($('band').value, previous);
  // A height that was set by hand is about the place, not the radio: keep it.
  // One still on the old band's starting figure makes way for the new band's.
  const before = bandStart(previous.band);
  for (const end of ['a', 'b']) {
    if (previous[end].height !== before[end].height) state.settings[end].height = previous[end].height;
  }
  showSettings();
  settingsChanged();
});

for (const [end, letter] of [['a', 'A'], ['b', 'B']]) {
  $(`radio-${end}`).addEventListener('change', () => {
    state.settings[end].radio = $(`radio-${end}`).value;
    dropOverrides([`power${letter}`, `sens${letter}`]);
    if (end === 'a') dropOverrides(['freqMHz', 'sf', 'bw']);
    if (!state.settings.split) state.settings = mirrorStations(state.settings);
    showSettings();
    settingsChanged();
  });
  $(`antenna-${end}`).addEventListener('change', () => {
    state.settings[end].antenna = $(`antenna-${end}`).value;
    dropOverrides([`gain${letter}`]);
    if (!state.settings.split) state.settings = mirrorStations(state.settings);
    showSettings();
    settingsChanged();
  });
}

$('split').addEventListener('change', () => {
  state.settings.split = $('split').checked;
  // Either way B starts as a copy of A: switching on gives a copy to change, switching off ties them again.
  state.settings = mirrorStations(state.settings);
  showSettings();
  settingsChanged();
});

$('fresnel').addEventListener('change', () => {
  state.settings.fresnel = $('fresnel').checked;
  if (state.draft) render();
  writeAddress();
});

for (const [id, name] of Object.entries(OVERRIDE_FIELDS)) {
  $(id).addEventListener('input', () => {
    const value = readNumber($(id), (v) => validOverride(name, v));
    if (value === null) return;
    state.settings.overrides[name] = value;
    settingsChanged();
  });
}

for (const [id, name] of Object.entries(POWER_FIELDS)) {
  $(id).addEventListener('input', () => {
    const inWatts = state.settings.powerUnit === 'W';
    const value = readNumber($(id), (v) => validOverride(name, inWatts ? v : dbmToWatts(v)));
    if (value === null) return;
    state.settings.overrides[name] = inWatts ? value : dbmToWatts(value);
    settingsChanged();
  });
}

el.powerUnit.addEventListener('change', () => {
  state.settings.powerUnit = el.powerUnit.value;
  showSettings(); // same power, shown in the other unit
  writeAddress();
});

for (const id of ['sf', 'bw']) {
  $(id).addEventListener('change', () => {
    state.settings.overrides[id] = Number($(id).value);
    showSettings();
    settingsChanged();
  });
}

$('max-samples').addEventListener('input', () => {
  const value = readNumber($('max-samples'), (v) => v >= 2000 && v <= 200000);
  if (value === null) return;
  state.settings.maxSamples = Math.round(value);
  settingsChanged();
});

$('k').addEventListener('input', () => {
  const value = readNumber($('k'), (v) => v >= 0.5 && v <= 10);
  if (value === null) return;
  state.settings.k = value;
  settingsChanged();
});

$('detail').addEventListener('change', () => {
  state.settings.detail = $('detail').value;
  settingsChanged();
});

// --- buttons ---------------------------------------------------------------------

el.loadDetail.addEventListener('click', () => {
  if (!state.pending) return;
  state.approved = true;
  update();
});

el.clear.addEventListener('click', () => {
  state.waypoints = [];
  pathChanged();
});

// Share: the page address already holds the points and every setting, so sharing is handing over the address.
let shareTimer = null;
function shareSaid(text) {
  el.share.textContent = text;
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    el.share.textContent = 'Share';
  }, 2500);
}
el.share.addEventListener('click', async () => {
  writeAddress();
  const url = location.href;
  // Phones have their own share sheet (messages, mail, ...). Elsewhere the link is copied.
  if (fingers && navigator.share) {
    try {
      await navigator.share({ title: 'Sightline', text: 'A path in Sightline', url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return; // closed the share sheet: nothing to do
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    shareSaid('Link copied');
  } catch {
    shareSaid('Copy the address bar');
  }
});

el.swap.addEventListener('click', () => {
  state.waypoints.reverse();
  const s = state.settings;
  // The stations travel with their points.
  [s.a, s.b] = [s.b, s.a];
  for (const key of ['power', 'gain', 'cable', 'sens']) {
    const [fromA, fromB] = [s.overrides[`${key}A`], s.overrides[`${key}B`]];
    delete s.overrides[`${key}A`];
    delete s.overrides[`${key}B`];
    if (fromB !== undefined) s.overrides[`${key}A`] = fromB;
    if (fromA !== undefined) s.overrides[`${key}B`] = fromA;
  }
  showSettings();
  pathChanged();
});

el.locate.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('This browser cannot share its location.', true);
    return;
  }
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const here = { lat: position.coords.latitude, lon: position.coords.longitude };
      // With both points placed, "my location" replaces A.
      if (state.waypoints.length >= 2) state.waypoints[0] = here;
      else state.waypoints.push(here);
      map.setView([here.lat, here.lon], Math.max(map.getZoom(), 11));
      pathChanged();
    },
    (error) => setStatus(`Could not get your location (${error.message}).`, true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

el.aboutOpen.addEventListener('click', () => el.about.showModal());

// Turning a phone changes the room the chart has: redraw it with the margins that fit.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.shown && state.draft && isCompact(el.chart) !== state.compact) render();
  }, 200);
});

let lastWrittenHash = '';
const rememberHash = () => {
  lastWrittenHash = location.hash;
};
window.addEventListener('hashchange', () => {
  if (location.hash === lastWrittenHash) return; // our own update, not a pasted link
  start(readAddress());
});

// --- start -----------------------------------------------------------------------

function start({ waypoints, settings, background: wanted, layers }) {
  state.waypoints = waypoints;
  state.settings = settings;
  showBackground(wanted);
  state.layersWanted = layers;
  showLayers(layers);
  showSettings();
  if (waypoints.length === 2) {
    map.fitBounds(
      [
        [waypoints[0].lat, waypoints[0].lon],
        [waypoints[1].lat, waypoints[1].lon],
      ],
      { padding: [40, 40], maxZoom: 14 },
    );
  } else if (waypoints.length === 1) {
    map.setView([waypoints[0].lat, waypoints[0].lon], 11);
  }
  pathChanged().then(rememberHash);
}

start(readAddress());
loadStations();

// Handy when testing from the browser's console.
// The chart takes its colours in script, so it is drawn again when the theme changes.
document.addEventListener('themechange', () => {
  if (state.shown) render();
});

globalThis.sightline = { state, terrain, map, sightFromA };
