// The page itself: the map, the two waypoints, the radio settings, and the
// order things happen in.
//
// When both points are placed it:
//   1. draws a draft from the 10 m data and works out the link,
//   2. decides where 2 m data would change the answer (near both antennas and
//      wherever the ground comes close to the Fresnel zone),
//   3. loads just those stretches (asking first if the download is large),
//      and works the link out again.
// Changing a radio setting redoes the sums at once and only downloads more
// terrain if the new settings need stretches that were not loaded before.
//
// L (Leaflet), GeoTIFF and Plotly are loaded by index.html before this file.

import { clearProfile, drawProfile } from './chart.js';
import { geodesicDistance, initialBearing, pointAlong } from './geo.js';
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
  DEFAULT_PRESET,
  PRESETS,
  settingsForPreset,
  settingsFromAddress,
  settingsToAddress,
  withSensitivity,
} from './settings.js';
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
  results: $('results'),
  verdictBox: $('verdict-box'),
  chart: $('chart'),
  readout: $('readout'),
  legend: $('legend'),
  status: $('status'),
  loadDetail: $('load-detail'),
  locate: $('locate'),
  swap: $('swap'),
  clear: $('clear'),
  about: $('about'),
  aboutOpen: $('about-open'),
  preset: $('preset'),
  powerUnit: $('power-unit'),
  sensNote: $('sens-note'),
};
// Number boxes, and the setting each one edits.
const FIELDS = {
  freq: 'freqMHz',
  'height-a': 'heightA',
  'height-b': 'heightB',
  'gain-a': 'gainA',
  'gain-b': 'gainB',
  'cable-a': 'cableA',
  'cable-b': 'cableB',
  sens: 'sensitivity',
  'max-samples': 'maxSamples',
  k: 'k',
};
const FIELD_LIMITS = {
  freqMHz: [1, 100000],
  heightA: [0, 1000],
  heightB: [0, 1000],
  gainA: [-30, 60],
  gainB: [-30, 60],
  cableA: [0, 100],
  cableB: [0, 100],
  sensitivity: [-200, 0],
  maxSamples: [2000, 200000],
  k: [0.5, 10],
};

// --- state -------------------------------------------------------------------

// For development: ?terrain=http://localhost:8081 reads tiles from another address.
const terrainOverride = new URLSearchParams(location.search).get('terrain');
const terrain = createTerrain(terrainOverride ? { GeoTIFF, baseUrl: terrainOverride } : { GeoTIFF });

const state = {
  waypoints: [], // { lat, lon }, at most two for now
  settings: settingsForPreset(DEFAULT_PRESET),
  run: 0, // goes up every time something changes, so old downloads can be ignored
  controller: null,
  draft: null, // the 10 m profile of the current path
  stretches: [], // 2 m stretches loaded so far for the current path
  approved: false, // has the user said yes to a large 2 m download for this path?
  shown: null, // what is on screen: { track, ground, link }
  pending: false,
};

// --- map ---------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView(START_VIEW.centre, START_VIEW.zoom);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const markers = [];
const pathLine = L.polyline([], { color: '#2f6fb7', weight: 3, opacity: 0.9 }).addTo(map);
const problemLines = L.layerGroup().addTo(map);
const hoverDot = L.circleMarker([0, 0], {
  radius: 6,
  color: '#ffffff',
  weight: 2,
  fillColor: '#203b3d',
  fillOpacity: 1,
  interactive: false,
});

function pinIcon(label) {
  return L.divIcon({
    className: '',
    html: `<div class="pin"><span>${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
  });
}

function drawPath() {
  if (state.waypoints.length < 2) {
    pathLine.setLatLngs([]);
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
}

/** Colour the grazing and blocked stretches of the path on the map. */
function drawProblemsOnMap(track, status) {
  problemLines.clearLayers();
  let current = null;
  const finish = () => {
    if (current && current.points.length > 1) {
      L.polyline(current.points, {
        color: current.kind === STATUS_BLOCKED ? '#c0392b' : '#d98a00',
        weight: 6,
        opacity: 0.95,
        interactive: false,
      }).addTo(problemLines);
    }
    current = null;
  };
  for (let i = 0; i < status.length; i++) {
    const kind = status[i];
    if (kind !== STATUS_GRAZING && kind !== STATUS_BLOCKED) {
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

// --- page address (so a setup can be shared as a link) -----------------------

function writeAddress() {
  const parts = state.waypoints.map(
    (wp, i) => `${LABELS[i].toLowerCase()}=${wp.lat.toFixed(5)},${wp.lon.toFixed(5)}`,
  );
  parts.push(...settingsToAddress(state.settings));
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
    waypoints.push({ lat, lon });
  }
  return { waypoints, settings: settingsFromAddress(params) };
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

function radioFromSettings() {
  const s = state.settings;
  return {
    freqMHz: s.freqMHz,
    powerW: s.powerW,
    gainA: s.gainA,
    gainB: s.gainB,
    cableA: s.cableA,
    cableB: s.cableB,
    heightA: s.heightA,
    heightB: s.heightB,
    sensitivity: s.sensitivity,
    k: s.k,
  };
}

// --- drawing the result ----------------------------------------------------------

/** Work the link out from the terrain loaded so far and put it on screen. */
function render() {
  const track = composeTrack(state.draft, state.stretches);
  const n = track.distance.length;
  // Heights above sea level (the files hold heights above the ellipsoid).
  const ground = new Float32Array(n);
  for (let i = 0; i < n; i++) ground[i] = track.height[i] - seaLevelOffset(track.lat[i], track.lon[i]);

  const km = Array.from(track.distance, (d) => d / 1000);
  const [a, b] = state.waypoints;
  const endsKnown = Number.isFinite(ground[0]) && Number.isFinite(ground[n - 1]);
  const link = endsKnown ? linkEstimate({ distances: track.distance, ground, radio: radioFromSettings() }) : null;
  state.shown = { track, ground, link };

  el.chart.hidden = false;
  el.readout.hidden = false;
  el.legend.hidden = !link;
  el.results.hidden = false;

  const view = link
    ? {
        km,
        terrain: link.path.terrain,
        los: link.path.los,
        fresnel: link.path.fresnel,
        status: link.path.status,
        edges: link.diffraction.edges.map((e) => ({ km: e.distance / 1000, height: e.height, loss: e.loss })),
        masts: { baseA: ground[0], tipA: link.path.tipA, baseB: ground[n - 1], tipB: link.path.tipB },
      }
    : { km, terrain: ground };

  const summary = link ? tightestSpotText(track, link) : '';
  el.readout.textContent = summary;
  drawProfile(Plotly, el.chart, view, {
    onHover: (index) => {
      if (index >= n) return;
      hoverDot.setLatLng([track.lat[index], track.lon[index]]).addTo(map);
      let text = `${fmtDistance(track.distance[index])} from A · ground ${fmtHeight(ground[index])}`;
      if (link && link.path.fresnel[index] > 0 && Number.isFinite(ground[index])) {
        const c = link.path.clearance[index];
        const share = (c / link.path.fresnel[index]) * 100;
        text +=
          c >= 0
            ? ` · ${c.toFixed(0)} m below the line of sight (${share.toFixed(0)}% of the Fresnel radius)`
            : ` · ${(-c).toFixed(0)} m above the line of sight`;
      }
      if (SOURCE_WORDS[track.source[index]]) text += ` · ${SOURCE_WORDS[track.source[index]]}`;
      el.readout.textContent = text;
    },
    onLeave: () => {
      hoverDot.remove();
      el.readout.textContent = summary;
    },
  });

  $('r-distance').textContent = fmtDistance(track.total);
  $('r-bearing').textContent = `${initialBearing(a, b).toFixed(0)}°`;
  el.verdictBox.className = 'verdict-box';
  if (!link) {
    for (const id of ['r-verdict', 'r-margin', 'r-received', 'r-fsl', 'r-diffraction', 'r-path']) $(id).textContent = '–';
    problemLines.clearLayers();
    return;
  }
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
  $('r-path').textContent = ['Clear', 'Grazing', 'Blocked'][link.path.overall];
  drawProblemsOnMap(track, link.path.status);
}

function tightestSpotText(track, link) {
  return `${worstSpotText(track, link)}${terrainLossText(link)}`;
}

/** One sentence on how the terrain loss was arrived at, when it needs explaining. */
function terrainLossText(link) {
  if (link.terrainMethod !== 'allowance') return '';
  const b = link.bullington;
  return ` Terrain loss: ${fmtDb(b.knifeEdge)} over the ridge plus ${fmtDb(b.allowance)} allowance for broad, real terrain.`;
}

function worstSpotText(track, link) {
  const i = link.path.worstIndex;
  if (i < 0) return '';
  const where = fmtDistance(track.distance[i]);
  const c = link.path.clearance[i];
  if (c < 0) return `Worst spot: ${where} from A, ground ${(-c).toFixed(0)} m above the line of sight.`;
  const share = (link.path.worstRatio * 100).toFixed(0);
  return `Tightest spot: ${where} from A, ground ${c.toFixed(0)} m below the line of sight (${share}% of the Fresnel radius).`;
}

function hideProfile() {
  state.shown = null;
  el.results.hidden = true;
  el.chart.hidden = true;
  el.readout.hidden = true;
  el.legend.hidden = true;
  el.readout.textContent = '';
  el.loadDetail.hidden = true;
  hoverDot.remove();
  problemLines.clearLayers();
  clearProfile(Plotly, el.chart);
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
  el.swap.disabled = state.waypoints.length < 2;
  el.clear.disabled = state.waypoints.length === 0;
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
      const draft = await buildProfile({
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

// --- radio settings ----------------------------------------------------------------

for (const [id, preset] of Object.entries(PRESETS)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = preset.label;
  el.preset.append(option);
}

const roundTo = (n, digits) => String(Math.round(n * 10 ** digits) / 10 ** digits);

/** Put the current settings into the boxes. */
function showSettings() {
  const s = state.settings;
  el.preset.value = s.preset;
  for (const [id, name] of Object.entries(FIELDS)) {
    $(id).value = roundTo(s[name], name === 'freqMHz' ? 4 : 2);
    $(id).classList.remove('invalid');
  }
  el.powerUnit.value = s.powerUnit;
  $('power').value = s.powerUnit === 'W' ? roundTo(s.powerW, 4) : roundTo(wattsToDbm(s.powerW), 1);
  $('power').classList.remove('invalid');
  $('sf').value = String(s.sf);
  $('bw').value = String(s.bw);
  $('detail').value = s.detail;
  $('sens').disabled = s.lora;
  for (const node of document.querySelectorAll('.lora-only')) node.hidden = !s.lora;
  el.sensNote.textContent = s.lora
    ? 'Sensitivity is worked out from the spreading factor and bandwidth. Higher spreading factor or narrower bandwidth hears weaker signals, at the cost of slower messages.'
    : 'Sensitivity is the weakest signal the receiver can use: −119 dBm is typical for FM, and that is "just readable", not comfortable. A stock rubber duck is about −3 dBi; set the real gain and height for a repeater or a yagi.';
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

function readNumber(input, [low, high]) {
  const value = Number(input.value);
  const ok = input.value.trim() !== '' && Number.isFinite(value) && value >= low && value <= high;
  input.classList.toggle('invalid', !ok);
  return ok ? value : null;
}

for (const [id, name] of Object.entries(FIELDS)) {
  $(id).addEventListener('input', () => {
    const value = readNumber($(id), FIELD_LIMITS[name]);
    if (value === null) return;
    state.settings[name] = name === 'maxSamples' ? Math.round(value) : value;
    settingsChanged();
  });
}

$('power').addEventListener('input', () => {
  const limits = state.settings.powerUnit === 'W' ? [0.000001, 100000] : [-30, 80];
  const value = readNumber($('power'), limits);
  if (value === null) return;
  state.settings.powerW = state.settings.powerUnit === 'W' ? value : dbmToWatts(value);
  settingsChanged();
});

el.powerUnit.addEventListener('change', () => {
  state.settings.powerUnit = el.powerUnit.value;
  showSettings(); // same power, shown in the other unit
  writeAddress();
});

for (const id of ['sf', 'bw']) {
  $(id).addEventListener('change', () => {
    state.settings[id] = Number($(id).value);
    state.settings = withSensitivity(state.settings);
    showSettings();
    settingsChanged();
  });
}

$('detail').addEventListener('change', () => {
  state.settings.detail = $('detail').value;
  settingsChanged();
});

el.preset.addEventListener('change', () => {
  state.settings = settingsForPreset(el.preset.value, state.settings);
  showSettings();
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

el.swap.addEventListener('click', () => {
  state.waypoints.reverse();
  const s = state.settings;
  // The antennas travel with their points.
  [s.heightA, s.heightB] = [s.heightB, s.heightA];
  [s.gainA, s.gainB] = [s.gainB, s.gainA];
  [s.cableA, s.cableB] = [s.cableB, s.cableA];
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

let lastWrittenHash = '';
const rememberHash = () => {
  lastWrittenHash = location.hash;
};
window.addEventListener('hashchange', () => {
  if (location.hash === lastWrittenHash) return; // our own update, not a pasted link
  start(readAddress());
});

// --- start -----------------------------------------------------------------------

function start({ waypoints, settings }) {
  state.waypoints = waypoints;
  state.settings = settings;
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

// Handy when testing from the browser's console.
globalThis.sightline = { state, terrain, map };
