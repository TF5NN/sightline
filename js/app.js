// The page itself: the map, the two waypoints, and the order things happen in.
//
// When both points are placed it:
//   1. draws a quick draft from the 10 m data,
//   2. works out how big the 2 m download would be,
//   3. loads the 2 m detail straight away if it is small, or offers a button if not.
//
// L (Leaflet), GeoTIFF and Plotly are loaded by index.html before this file.

import { clearProfile, drawProfile } from './chart.js';
import { geodesicDistance, initialBearing, pointAlong } from './geo.js';
import { seaLevelOffset } from './geoid.js';
import { SOURCE_FILLED, buildProfile, fillGaps, heightRange, pathSamples } from './profile.js';
import { createTerrain } from './terrain.js';

const { L, GeoTIFF, Plotly } = globalThis;

// --- settings ----------------------------------------------------------------

const START_VIEW = { centre: [64.9, -18.6], zoom: 6 }; // Iceland
const DRAFT_MAX_SAMPLES = 4000;
const DETAIL_MAX_SAMPLES = 20000;
// 2 m detail loads on its own when the download is smaller than this. Above it
// the app asks first, so nobody burns mobile data by accident.
const AUTO_DETAIL_BYTES = 15_000_000;
const LABELS = ['A', 'B'];

// --- page elements ---------------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
  hint: $('hint'),
  results: $('results'),
  chart: $('chart'),
  readout: $('readout'),
  status: $('status'),
  fast: $('fast'),
  loadDetail: $('load-detail'),
  locate: $('locate'),
  swap: $('swap'),
  clear: $('clear'),
  about: $('about'),
  aboutOpen: $('about-open'),
};

// --- state -------------------------------------------------------------------

// For development: ?terrain=http://localhost:8081 reads tiles from another address.
const terrainOverride = new URLSearchParams(location.search).get('terrain');
const terrain = createTerrain(terrainOverride ? { GeoTIFF, baseUrl: terrainOverride } : { GeoTIFF });
const state = {
  waypoints: [], // { lat, lon }, at most two for now
  fast: false,
  run: 0, // goes up every time the path changes, so old downloads can be ignored
  controller: null,
  draft: null,
  shown: null, // the profile currently on screen, with sea-level heights
  pendingDetail: null,
};

// --- map ---------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView(START_VIEW.centre, START_VIEW.zoom);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const markers = [];
const pathLine = L.polyline([], { color: '#267c62', weight: 3, opacity: 0.9 }).addTo(map);
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

// --- page address (so a path can be shared as a link) -------------------------

function writeAddress() {
  const parts = state.waypoints.map(
    (wp, i) => `${LABELS[i].toLowerCase()}=${wp.lat.toFixed(5)},${wp.lon.toFixed(5)}`,
  );
  if (state.fast) parts.push('fast=1');
  const address = parts.length ? `#${parts.join('&')}` : location.pathname + location.search;
  history.replaceState(null, '', address);
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
  return { waypoints, fast: params.get('fast') === '1' };
}

// --- small helpers -------------------------------------------------------------

function setStatus(text, problem = false) {
  el.status.textContent = text;
  el.status.classList.toggle('problem', problem);
}

const fmtDistance = (m) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
const fmtHeight = (h) => (Number.isFinite(h) ? `${Math.round(h)} m` : 'no data');
const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;
const isCancel = (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''));

/** Turn a raw profile (heights above the ellipsoid) into what the chart shows. */
function toView(profile, draft) {
  const n = profile.heights.length;
  const km = new Array(n);
  const heights = new Float32Array(n);
  const filled = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = profile.points[i];
    km[i] = p.distance / 1000;
    heights[i] = profile.heights[i] - seaLevelOffset(p.lat, p.lon);
    filled[i] = profile.source[i] === SOURCE_FILLED;
  }
  return { km, heights, filled, draft, profile };
}

function showProfile(profile, draft) {
  const view = toView(profile, draft);
  state.shown = view;
  el.chart.hidden = false;
  el.readout.hidden = false;
  drawProfile(Plotly, el.chart, view, {
    onHover: (index) => {
      const p = profile.points[index];
      hoverDot.setLatLng([p.lat, p.lon]).addTo(map);
      const source = view.filled[index] ? ' (filled from coarser data)' : '';
      el.readout.textContent = `${fmtDistance(p.distance)} from A · ground ${fmtHeight(view.heights[index])}${source}`;
    },
    onLeave: () => {
      hoverDot.remove();
      el.readout.textContent = '';
    },
  });

  const [a, b] = state.waypoints;
  const range = heightRange(view.heights);
  const filledShare = view.filled.filter(Boolean).length / view.filled.length;
  $('r-distance').textContent = fmtDistance(profile.total);
  $('r-bearing').textContent = `${initialBearing(a, b).toFixed(0)}°`;
  $('r-a').textContent = fmtHeight(view.heights[0]);
  $('r-b').textContent = fmtHeight(view.heights[view.heights.length - 1]);
  $('r-high').textContent = range ? fmtHeight(range.max) : 'no data';
  $('r-data').textContent =
    (draft ? '10 m draft' : `2 m, every ${profile.spacing.toFixed(1)} m`) +
    (filledShare > 0.001 ? `, ${(filledShare * 100).toFixed(0)}% filled` : '');
  el.results.hidden = false;
}

function hideProfile() {
  state.shown = null;
  state.draft = null;
  state.pendingDetail = null;
  el.results.hidden = true;
  el.chart.hidden = true;
  el.readout.hidden = true;
  el.readout.textContent = '';
  el.loadDetail.hidden = true;
  hoverDot.remove();
  clearProfile(Plotly, el.chart);
}

function explainNoData(problems) {
  if (problems.blocked > 0) {
    return 'Could not reach the terrain data. Check your connection and try again. If it keeps happening, run the data connection test linked at the bottom of the page.';
  }
  return 'No terrain data on this path. ArcticDEM covers land north of about 60°N.';
}

// --- the main sequence -----------------------------------------------------------

async function pathChanged() {
  syncMarkers();
  writeAddress();
  el.swap.disabled = state.waypoints.length < 2;
  el.clear.disabled = state.waypoints.length === 0;
  el.hint.hidden = state.waypoints.length >= 2;
  if (state.waypoints.length === 1) el.hint.textContent = 'Now tap the map to place point B.';
  if (state.waypoints.length === 0) {
    el.hint.textContent = 'Tap the map to place point A, then point B. Drag a point to move it.';
  }

  // Anything still downloading for the old path is no longer wanted.
  state.controller?.abort();
  state.run += 1;
  hideProfile();
  setStatus('');
  if (state.waypoints.length < 2) return;

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
    // 1. Quick draft from the 10 m layer.
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
    showProfile(draft, true);

    if (state.fast) {
      setStatus('Showing 10 m data. Untick the box above to load 2 m detail.');
      return;
    }

    // 2. How big would the 2 m download be?
    setStatus('Checking the size of the 2 m detail…');
    const samples = pathSamples(a, b, '2m', DETAIL_MAX_SAMPLES);
    const cost = await terrain.estimate('2m', samples.grid);
    if (!stillCurrent()) return;

    if (cost.blocks === 0) {
      setStatus('Showing 10 m data. There is no 2 m data on this path.');
      return;
    }

    // 3. Load it now if small, otherwise ask.
    if (cost.blocksToFetch === 0 || (cost.bytesToFetch > 0 && cost.bytesToFetch <= AUTO_DETAIL_BYTES)) {
      await loadDetail(run, controller);
    } else {
      const size = cost.bytesToFetch > 0 ? `about ${fmtMB(cost.bytesToFetch)}` : `${cost.blocksToFetch} blocks`;
      state.pendingDetail = { run, controller };
      el.loadDetail.textContent = `Load 2 m detail (${size})`;
      el.loadDetail.hidden = false;
      setStatus(`Showing the 10 m draft. The 2 m detail for this path is a larger download: ${size}.`);
    }
  } catch (error) {
    if (isCancel(error) || !stillCurrent()) return;
    console.error(error);
    setStatus(`Something went wrong while reading the terrain: ${error.message ?? error}`, true);
  }
}

async function loadDetail(run, controller) {
  const [a, b] = state.waypoints;
  const stillCurrent = () => run === state.run;
  el.loadDetail.hidden = true;
  state.pendingDetail = null;
  try {
    setStatus('Loading 2 m detail…');
    const detail = await buildProfile({
      terrain,
      a,
      b,
      layerId: '2m',
      maxSamples: DETAIL_MAX_SAMPLES,
      signal: controller.signal,
      onProgress: (done, total) => {
        if (stillCurrent()) setStatus(`Loading 2 m detail… ${done} of ${total} blocks`);
      },
    });
    if (!stillCurrent()) return;
    if (state.draft) fillGaps(detail, state.draft);
    if (!heightRange(detail.heights)) {
      setStatus('Showing 10 m data. There is no 2 m data on this path.');
      return;
    }
    showProfile(detail, false);
    setStatus(
      `Done. ${detail.heights.length.toLocaleString('en')} samples from ${detail.blocks} blocks of 2 m data.`,
    );
  } catch (error) {
    if (isCancel(error) || !stillCurrent()) return;
    console.error(error);
    setStatus(`Could not load the 2 m detail (${error.message ?? error}). The 10 m draft is still shown.`, true);
  }
}

// --- buttons ---------------------------------------------------------------------

el.loadDetail.addEventListener('click', () => {
  if (state.pendingDetail) loadDetail(state.pendingDetail.run, state.pendingDetail.controller);
});

el.fast.addEventListener('change', () => {
  state.fast = el.fast.checked;
  pathChanged();
});

el.clear.addEventListener('click', () => {
  state.waypoints = [];
  pathChanged();
});

el.swap.addEventListener('click', () => {
  state.waypoints.reverse();
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

window.addEventListener('hashchange', () => {
  const fromAddress = readAddress();
  const same =
    fromAddress.waypoints.length === state.waypoints.length &&
    fromAddress.waypoints.every(
      (wp, i) =>
        Math.abs(wp.lat - state.waypoints[i].lat) < 1e-5 && Math.abs(wp.lon - state.waypoints[i].lon) < 1e-5,
    ) &&
    fromAddress.fast === state.fast;
  if (same) return;
  start(fromAddress);
});

// --- start -----------------------------------------------------------------------

function start({ waypoints, fast }) {
  state.waypoints = waypoints;
  state.fast = fast;
  el.fast.checked = fast;
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
  pathChanged();
}

start(readAddress());

// Handy when testing from the browser's console.
globalThis.sightline = { state, terrain, map };
