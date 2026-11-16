// The "step 0" proof test. It answers the questions the whole design rests on:
//   - Is this browser allowed to read pieces of the terrain files directly?
//   - Are the files named and laid out the way js/tiles.js assumes?
//   - How big are the internal blocks, and how long does each take to arrive?
// It prints a plain report that can be copied and sent on.

import { buildProfile, pathSamples } from './profile.js';
import { toGrid } from './projection.js';
import { createTerrain } from './terrain.js';
import { DEFAULT_BASE_URL, tileCandidates } from './tiles.js';

const { GeoTIFF } = globalThis;
const override = new URLSearchParams(location.search).get('terrain');
const BASE = override || DEFAULT_BASE_URL;

// Esja summit area to central Reykjavik: about 18 km, mountain to sea level.
const A = { lat: 64.2431, lon: -21.65 };
const B = { lat: 64.147, lon: -21.94 };

const logEl = document.getElementById('log');
const verdictEl = document.getElementById('verdict');
const fullButton = document.getElementById('full');
let terrain;

const say = (line = '') => {
  logEl.textContent += `${line}\n`;
};
const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

async function directRead(url) {
  // Ask for the first 16 bytes only. This is the plainest possible "partial read".
  const t0 = performance.now();
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    const body = await response.arrayBuffer();
    return {
      reached: true,
      status: response.status,
      bytes: body.byteLength,
      partial: response.status === 206,
      time: ms(t0),
    };
  } catch (error) {
    return { reached: false, error: String(error), time: ms(t0) };
  }
}

async function describeFile(url) {
  const t0 = performance.now();
  const tiff = await GeoTIFF.fromUrl(url);
  const image = await tiff.getImage(0);
  const opened = ms(t0);
  const levels = await tiff.getImageCount();
  const fd = image.fileDirectory;
  const value = async (name) => {
    try {
      return await fd.loadValue(name);
    } catch {
      return undefined;
    }
  };
  const sizes = await value('TileByteCounts');
  let blockStats = 'unknown';
  if (sizes && sizes.length) {
    const list = Array.from(sizes, Number).filter((n) => n > 0).sort((a, b) => a - b);
    const total = list.reduce((s, n) => s + n, 0);
    blockStats = `${sizes.length} blocks, ${list.length} with data; typical ${kb(list[Math.floor(list.length / 2)] ?? 0)}, largest ${kb(list[list.length - 1] ?? 0)}, whole file ${(total / 1e6).toFixed(0)} MB`;
  }
  const compression = { 1: 'none', 5: 'LZW', 8: 'Deflate', 32946: 'Deflate', 34887: 'LERC', 50000: 'Zstandard' };
  const comp = await value('Compression');
  return {
    image,
    lines: [
      `  opened in ${opened}`,
      `  size ${image.getWidth()} x ${image.getHeight()} cells, cell ${image.getResolution()[0]} m`,
      `  top-left corner at x ${image.getOrigin()[0]}, y ${image.getOrigin()[1]}`,
      `  internal blocks ${image.getTileWidth()} x ${image.getTileHeight()} cells`,
      `  compression ${compression[comp] ?? comp}, predictor ${(await value('Predictor')) ?? 'none'}, ${(await value('BitsPerSample'))?.[0]} bits`,
      `  no-data value ${image.getGDALNoData()}`,
      `  resolution levels in the file: ${levels}${levels > 1 ? ' (coarser copies are built in)' : ''}`,
      `  stored blocks: ${blockStats}`,
    ],
  };
}

async function run() {
  logEl.textContent = '';
  verdictEl.textContent = 'Running…';
  verdictEl.classList.remove('bad');
  fullButton.disabled = true;
  terrain = createTerrain({ GeoTIFF, baseUrl: BASE });
  const problems = [];

  say(`Sightline data connection test, ${new Date().toISOString()}`);
  say(`Page: ${location.origin}${location.pathname}`);
  say(`Browser: ${navigator.userAgent}`);
  say(`Terrain source: ${BASE}`);
  say();

  const centre = toGrid(A.lat, A.lon);
  say(`Test point ${A.lat}, ${A.lon} is at grid x ${centre.x.toFixed(0)}, y ${centre.y.toFixed(0)}`);
  say();

  // 1. Plain partial reads, one per layer.
  say('1. Can the browser read a piece of each layer?');
  let anyReached = false;
  const working = {};
  for (const layer of ['10m', '32m', '2m']) {
    for (const candidate of tileCandidates(layer, centre.x, centre.y, BASE)) {
      const r = await directRead(candidate.url);
      const name = candidate.url.split('/').pop();
      if (!r.reached) {
        say(`  ${layer}  ${name}: BLOCKED or offline (${r.error}), ${r.time}`);
        continue;
      }
      anyReached = true;
      const ok = r.status === 206 || r.status === 200;
      say(
        `  ${layer}  ${name}: HTTP ${r.status}${r.partial ? ' partial read OK' : ''}${r.status === 200 ? ' (server sent the whole file: partial reads NOT honoured)' : ''}${ok ? '' : ' (no such file)'}, ${r.bytes} bytes, ${r.time}`,
      );
      if (ok && !working[layer]) working[layer] = candidate.url;
      if (r.status === 200) problems.push(`${layer}: partial reads are not honoured`);
    }
  }
  say();

  if (!anyReached) {
    problems.push('the browser could not reach the terrain storage at all');
  }
  for (const layer of ['10m', '32m', '2m']) {
    if (anyReached && !working[layer]) problems.push(`no ${layer} file found under the expected name`);
  }

  // If names did not match, show what the storage's own catalogue lists.
  if (anyReached && Object.keys(working).length < 3) {
    say('   Some files were not found under the expected names. Looking at the catalogue for clues:');
    const root = BASE.replace(/\/v4\.1$/, '');
    for (const url of [`${BASE}/2m.json`, `${BASE}/2m/14_52.json`, `${BASE}.json`, `${root}.json`]) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          say(`   ${url}: HTTP ${response.status}`);
          continue;
        }
        const json = await response.json();
        const links = (json.links ?? []).filter((l) => l.rel === 'child' || l.rel === 'item').map((l) => l.href);
        say(`   ${url}: ${links.length} entries, for example ${links.slice(0, 6).join(', ')}`);
        const near = links.filter((h) => /14_5[123]|15_5[123]|13_5[123]/.test(h)).slice(0, 12);
        if (near.length) say(`     near the test point: ${near.join(', ')}`);
      } catch (error) {
        say(`   ${url}: ${error}`);
      }
    }
    say();
  }

  // 2. File layout.
  say('2. How are the files laid out?');
  const opened = {};
  for (const layer of ['2m', '10m', '32m']) {
    if (!working[layer]) continue;
    try {
      say(` ${layer}: ${working[layer].split('/').pop()}`);
      const info = await describeFile(working[layer]);
      info.lines.forEach((l) => say(l));
      opened[layer] = info.image;
    } catch (error) {
      say(`  could not be opened as a terrain file: ${error}`);
      problems.push(`${layer} file could not be opened: ${error}`);
    }
  }
  say();

  // 3. Timing of individual blocks.
  if (opened['2m']) {
    say('3. How long does one 2 m block take?');
    const image = opened['2m'];
    const bw = image.getTileWidth();
    const bh = image.getTileHeight();
    const px = Math.floor((centre.x - image.getOrigin()[0]) / image.getResolution()[0] / bw);
    const py = Math.floor((centre.y - image.getOrigin()[1]) / image.getResolution()[1] / bh);
    const read = (bx, by) =>
      image.readRasters({ window: [bx * bw, by * bh, (bx + 1) * bw, (by + 1) * bh], samples: [0] });
    try {
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const r = await read(px + i, py);
        let low = Infinity;
        let high = -Infinity;
        for (const v of r[0]) {
          if (v > -1000 && v < low) low = v;
          if (v > -1000 && v > high) high = v;
        }
        say(`  one block: ${ms(t0)} (heights ${low.toFixed(0)} to ${high.toFixed(0)} m above the ellipsoid)`);
      }
      const t0 = performance.now();
      await Promise.all([0, 1, 2, 3, 4, 5].map((i) => read(px + i, py + 1)));
      say(`  six blocks at once: ${ms(t0)}`);
    } catch (error) {
      say(`  reading blocks failed: ${error}`);
      problems.push(`reading 2 m blocks failed: ${error}`);
    }
    say();
  }

  // 4. A real profile, the way the app does it.
  say(`4. A real path: Esja to Reykjavik`);
  try {
    let t0 = performance.now();
    const draft = await buildProfile({ terrain, a: A, b: B, layerId: '10m', maxSamples: 4000 });
    say(
      `  10 m draft: ${(draft.total / 1000).toFixed(2)} km, ${draft.heights.length} samples, ${draft.blocks} blocks, ${(draft.coverage * 100).toFixed(0)}% covered, ${ms(t0)}`,
    );
    if (draft.coverage === 0) problems.push('the 10 m draft returned no heights');
    t0 = performance.now();
    const samples = pathSamples(A, B, '2m', 20000);
    const cost = await terrain.estimate('2m', samples.grid);
    say(
      `  2 m detail would need ${cost.blocks} blocks, ${(cost.bytesToFetch / 1e6).toFixed(1)} MB to download (worked out in ${ms(t0)})`,
    );
    if (cost.blocks > 0 && draft.total > 0) {
      say(`  that is ${(cost.bytesToFetch / 1e6 / (draft.total / 1000)).toFixed(2)} MB per km of path`);
    }
    fullButton.disabled = cost.blocks === 0;
  } catch (error) {
    say(`  failed: ${error}`);
    problems.push(`the test profile failed: ${error}`);
  }
  say();

  if (problems.length === 0) {
    verdictEl.textContent = 'All good: this browser can read the terrain files directly, and they are laid out as expected.';
  } else {
    verdictEl.classList.add('bad');
    verdictEl.textContent = `Found ${problems.length} problem${problems.length > 1 ? 's' : ''}: ${problems.join('; ')}.`;
  }
  say(problems.length === 0 ? 'RESULT: PASS' : `RESULT: PROBLEMS\n- ${problems.join('\n- ')}`);
}

fullButton.addEventListener('click', async () => {
  fullButton.disabled = true;
  say();
  say('5. Full 2 m profile, Esja to Reykjavik');
  const t0 = performance.now();
  try {
    const detail = await buildProfile({ terrain, a: A, b: B, layerId: '2m', maxSamples: 20000 });
    say(
      `  ${detail.heights.length} samples from ${detail.blocks} blocks, ${(detail.coverage * 100).toFixed(1)}% covered, ${ms(t0)}`,
    );
  } catch (error) {
    say(`  failed: ${error}`);
  }
});

document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`${verdictEl.textContent}\n\n${logEl.textContent}`);
    document.getElementById('copy').textContent = 'Copied';
  } catch {
    // Clipboard not allowed: select the text so it can be copied by hand.
    getSelection().selectAllChildren(logEl);
  }
});
document.getElementById('again').addEventListener('click', run);

run();
