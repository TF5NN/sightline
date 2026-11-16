// Batch link check: runs every pair in a pasted list of stations through the
// same terrain and radio sums as the app, and sets the prediction beside the
// links that were actually measured. A way to see whether the model is close.
//
// The radio is the MeshCore EU/UK narrow setup at both ends. What is not known
// about real stations (antenna, height, cable) is one figure for all of them,
// so expect scatter: the question is whether the model leans one way overall.
//
// The steps per pair are the same as in js/app.js (10 m draft, 32 m to fill
// holes, 2 m where it matters), without the map and the chart.

import { geodesicDistance } from './geo.js';
import { seaLevelOffset } from './geoid.js';
import { buildProfile, composeTrack, detailSpacing, fillGaps, heightRange, stretchSamples } from './profile.js';
import { detailStretches, linkEstimate, subtractStretches } from './radio.js';
import { resolveRadio, settingsForBand } from './settings.js';
import { createTerrain } from './terrain.js';

const { GeoTIFF } = globalThis;
const $ = (id) => document.getElementById(id);
const override = new URLSearchParams(location.search).get('terrain');

const DRAFT_MAX_SAMPLES = 4000;
const MAX_SAMPLES = 20000;
const DETAIL_PASSES = 3;
const LARGE_DETAIL_BYTES = 15_000_000; // the app asks before loading more than this; here it is skipped and noted
const SATURATED_SNR = 8; // above about this, a LoRa receiver's SNR figure stops saying how strong the signal is

let controller = null;

/** Terrain and link for one pair of stations. */
async function checkPair(terrain, a, b, radio, detail, signal) {
  const draft = await buildProfile({ terrain, a, b, layerId: '10m', maxSamples: DRAFT_MAX_SAMPLES, signal });
  if (draft.coverage < 1) {
    const coarse = await buildProfile({ terrain, a, b, layerId: '32m', maxSamples: DRAFT_MAX_SAMPLES, signal });
    fillGaps(draft, coarse);
  }
  if (!heightRange(draft.heights)) return { note: 'no terrain data' };

  const stretches = [];
  let note = '';
  const estimate = () => {
    const track = composeTrack(draft, stretches);
    const n = track.distance.length;
    const ground = new Float32Array(n);
    for (let i = 0; i < n; i++) ground[i] = track.height[i] - seaLevelOffset(track.lat[i], track.lon[i]);
    if (!Number.isFinite(ground[0]) || !Number.isFinite(ground[n - 1])) return { track, link: null };
    return { track, link: linkEstimate({ distances: track.distance, ground, radio }) };
  };

  let { track, link } = estimate();
  if (!link) return { note: 'no terrain under a station' };
  for (let pass = 0; detail === 'smart' && pass < DETAIL_PASSES; pass++) {
    const wanted = detailStretches({ distances: track.distance, path: link.path, diffraction: link.diffraction });
    const missing = subtractStretches(wanted, stretches.map((s) => [s.from, s.to]));
    if (missing.length === 0) break;
    const spacing = detailSpacing(wanted, draft.heights.length, MAX_SAMPLES);
    const sets = missing.map(([from, to]) => stretchSamples(a, b, track.total, from, to, spacing));
    const grid = sets.flatMap((s) => s.grid);
    const cost = await terrain.estimate('2m', grid);
    if (cost.blocks === 0) break;
    if (cost.bytesToFetch > LARGE_DETAIL_BYTES) {
      note = '2 m detail skipped (large)';
      break;
    }
    const result = await terrain.sample('2m', grid, { signal });
    let offset = 0;
    for (const set of sets) {
      const count = set.distance.length;
      stretches.push({ from: set.from, to: set.to, distance: set.distance, lat: set.lat, lon: set.lon, height: result.heights.subarray(offset, offset + count) });
      offset += count;
    }
    ({ track, link } = estimate());
    if (!link) return { note: 'no terrain under a station' };
  }
  return { link, note };
}

function readInput() {
  const data = JSON.parse($('input').value);
  if (!Array.isArray(data.nodes) || data.nodes.length < 2) throw new Error('"nodes" must list at least two stations');
  const nodes = data.nodes.map((n) => ({ id: String(n.id), name: String(n.name ?? n.id), lat: Number(n.lat), lon: Number(n.lon) }));
  for (const n of nodes) {
    if (!Number.isFinite(n.lat) || !Number.isFinite(n.lon)) throw new Error(`station "${n.name}" has no usable position`);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const measured = new Map();
  for (const l of data.links ?? []) {
    if (!ids.has(String(l.a)) || !ids.has(String(l.b))) throw new Error(`link ${l.a}-${l.b} names a station that is not in "nodes"`);
    measured.set([String(l.a), String(l.b)].sort().join('|'), { snr: Number(l.snr), count: Number(l.count ?? 1) });
  }
  return { nodes, measured, title: String(data.title ?? '') };
}

const pad = (text, width) => String(text).padEnd(width).slice(0, width);
const num = (value, width, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '–').padStart(width);
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function run() {
  const log = $('log');
  const progress = $('progress');
  log.textContent = '';
  let input;
  try {
    input = readInput();
  } catch (error) {
    progress.textContent = `Cannot read the list: ${error.message}`;
    return;
  }
  const gain = Number($('gain').value);
  const height = Number($('height').value);
  const detail = $('detail').value;
  if (!Number.isFinite(gain) || !Number.isFinite(height) || height < 0) {
    progress.textContent = 'Antenna gain and height must be numbers.';
    return;
  }

  const settings = settingsForBand('lora868');
  settings.a.height = height;
  settings.b.height = height;
  settings.overrides.gainA = gain;
  settings.overrides.gainB = gain;
  const radio = resolveRadio(settings);
  // What the receiver hears with no signal: thermal noise in the bandwidth plus a 6 dB receiver.
  const noiseFloor = -174 + 10 * Math.log10(radio.lora.bw * 1000) + 6;
  const snrLimit = radio.sensA - noiseFloor; // the weakest SNR this spreading factor can decode

  const terrain = createTerrain(override ? { GeoTIFF, baseUrl: override, maxCachedBlocks: 250 } : { GeoTIFF, maxCachedBlocks: 250 });
  controller = new AbortController();
  $('run').disabled = true;
  $('stop').disabled = false;
  $('copy').disabled = true;

  const pairs = [];
  for (let i = 0; i < input.nodes.length; i++) for (let j = i + 1; j < input.nodes.length; j++) pairs.push([input.nodes[i], input.nodes[j]]);
  const rows = [];
  const started = performance.now();
  let stopped = false;
  for (let p = 0; p < pairs.length; p++) {
    const [a, b] = pairs[p];
    progress.textContent = `Pair ${p + 1} of ${pairs.length}: ${a.name} to ${b.name}… (${terrain.stats.blocksFetched} terrain blocks read so far)`;
    const row = { a, b, km: geodesicDistance(a, b) / 1000, measured: input.measured.get([a.id, b.id].sort().join('|')) ?? null };
    try {
      const { link, note } = await checkPair(terrain, a, b, radio, detail, controller.signal);
      row.note = note ?? '';
      if (link) {
        row.snr = link.received - noiseFloor;
        row.terrainLoss = link.terrainLoss;
        row.path = ['clear', 'grazing', 'blocked'][link.path.overall];
      }
    } catch (error) {
      if (controller.signal.aborted) {
        stopped = true;
        break;
      }
      row.note = `failed: ${error.message ?? error}`;
    }
    rows.push(row);
  }

  // --- the report ---
  const lines = [];
  const say = (line = '') => lines.push(line);
  say('Sightline batch link check');
  if (input.title) say(input.title);
  say(`Run ${new Date().toISOString()} from ${location.host}${stopped ? '  (STOPPED EARLY)' : ''}`);
  say(`Radio: ${radio.freqMHz} MHz, SF${radio.lora.sf}, ${radio.lora.bw} kHz, ${(10 * Math.log10(radio.powerA * 1000)).toFixed(0)} dBm, ${gain} dBi and ${height} m at both ends.`);
  say(`Noise floor taken as ${noiseFloor.toFixed(1)} dBm; a link needs an SNR of ${snrLimit.toFixed(1)} dB or better. Terrain detail: ${detail}.`);
  say(`${rows.length} pairs, ${terrain.stats.blocksFetched} terrain blocks read, ${((performance.now() - started) / 1000).toFixed(0)} s.`);
  say();

  const header = `${pad('A', 22)} ${pad('B', 22)} ${'km'.padStart(6)} ${pad('path', 8)} ${'terr dB'.padStart(7)} ${'pred'.padStart(6)} ${'meas'.padStart(6)} ${'n'.padStart(6)}  note`;
  const line = (r) =>
    `${pad(r.a.name, 22)} ${pad(r.b.name, 22)} ${num(r.km, 6)} ${pad(r.path ?? '–', 8)} ${num(r.terrainLoss, 7)} ${num(r.snr, 6)} ${num(r.measured?.snr, 6)} ${String(r.measured?.count ?? '').padStart(6)}  ${r.note ?? ''}`;

  const heard = rows.filter((r) => r.measured).sort((x, y) => x.km - y.km);
  const silent = rows.filter((r) => !r.measured).sort((x, y) => x.km - y.km);
  const usable = (r) => Number.isFinite(r.snr);

  say(`LINKS THAT WERE MEASURED (${heard.length})   pred and meas are SNR in dB`);
  say(header);
  for (const r of heard) say(line(r) + (usable(r) && r.snr < snrLimit ? '  << model says no link' : ''));
  say();
  say(`PAIRS WITH NO MEASURED LINK (${silent.length})`);
  say(header);
  for (const r of silent) say(line(r) + (usable(r) && r.snr >= snrLimit ? '  << model says it should work' : ''));
  say();

  say('SUMMARY');
  const heardOk = heard.filter(usable);
  const missed = heardOk.filter((r) => r.snr < snrLimit);
  say(`Measured links the model also says work: ${heardOk.length - missed.length} of ${heardOk.length}.`);
  const weak = heardOk.filter((r) => r.measured.snr < SATURATED_SNR && r.measured.count >= 5);
  if (weak.length) {
    const errors = weak.map((r) => r.snr - r.measured.snr);
    say(`Where the measured SNR is below ${SATURATED_SNR} dB and seen 5 times or more (${weak.length} links): predicted minus measured,`);
    say(`  mean ${mean(errors).toFixed(1)} dB, median ${median(errors).toFixed(1)} dB, from ${Math.min(...errors).toFixed(1)} to ${Math.max(...errors).toFixed(1)} dB.`);
    say('  Positive means the model is too optimistic.');
  }
  const strong = heardOk.filter((r) => r.measured.snr >= SATURATED_SNR);
  if (strong.length) {
    const fine = strong.filter((r) => r.snr >= SATURATED_SNR).length;
    say(`Where the measured SNR is ${SATURATED_SNR} dB or more (${strong.length} links, receiver figure tops out): model also says ${SATURATED_SNR} dB or more on ${fine}.`);
  }
  const silentOk = silent.filter(usable);
  const shouldWork = silentOk.filter((r) => r.snr >= snrLimit);
  say(`Pairs never measured that the model says should work: ${shouldWork.length} of ${silentOk.length}.`);
  say('  (A pair can be silent for other reasons: the mesh simply never routed that way.)');
  const failed = rows.filter((r) => !usable(r)).length;
  if (failed) say(`Pairs that could not be worked out: ${failed}.`);
  say();
  say('RESULT: DONE');

  log.textContent = lines.join('\n');
  progress.textContent = stopped ? 'Stopped. The report covers the pairs done so far.' : 'Done. Copy the report and send it on.';
  $('run').disabled = false;
  $('stop').disabled = true;
  $('copy').disabled = false;
}

$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => controller?.abort());
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('log').textContent);
  $('progress').textContent = 'Copied.';
});
