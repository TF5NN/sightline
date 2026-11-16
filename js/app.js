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
L.control.layers({ Map: backgrounds.map, Satellite: backgrounds.sat }, null, { position: 'topright' }).addTo(map);
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
  if (background !== 'map') parts.push(`bg=${background}`);
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
  return { waypoints, settings: settingsFromAddress(params), background: params.get('bg') ?? 'map' };
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

function start({ waypoints, settings, background: wanted }) {
  state.waypoints = waypoints;
  state.settings = settings;
  showBackground(wanted);
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
