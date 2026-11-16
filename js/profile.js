// Builds a terrain profile: the heights along the straight path between two
// points. Sits between the map (which knows the waypoints) and the terrain
// reader (which knows the files).

import { geodesicDistance, pointAlong, samplePath } from './geo.js';
import { toGrid } from './projection.js';
import { LAYERS } from './tiles.js';

// Where each height in a profile came from.
export const SOURCE_NONE = 0; // no data at all
export const SOURCE_OWN = 1; // the layer that was asked for
export const SOURCE_FILLED = 2; // a hole, filled from a coarser profile

/** How many samples a path gets, and how far apart they end up. */
export function planSamples(totalMetres, layerId, maxSamples) {
  const wanted = LAYERS[layerId].resolution;
  const count = Math.max(2, Math.min(maxSamples, Math.ceil(totalMetres / wanted) + 1));
  return { count, spacing: totalMetres / (count - 1) };
}

/** The sample positions for a path, both as lat/lon and on the terrain grid. */
export function pathSamples(a, b, layerId, maxSamples) {
  const total = geodesicDistance(a, b);
  const { count, spacing } = planSamples(total, layerId, maxSamples);
  const points = samplePath(a, b, count);
  const grid = points.map((p) => toGrid(p.lat, p.lon));
  return { total, count, spacing, points, grid };
}

/**
 * Read one profile from one terrain layer.
 * Heights are as stored in the files: metres above the WGS84 ellipsoid.
 *
 * @param {{ terrain: any, a: {lat: number, lon: number}, b: {lat: number, lon: number}, layerId: string,
 *   maxSamples?: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} options
 */
export async function buildProfile({ terrain, a, b, layerId, maxSamples = 20000, onProgress, signal }) {
  const { total, count, spacing, points, grid } = pathSamples(a, b, layerId, maxSamples);
  const result = await terrain.sample(layerId, grid, { onProgress, signal });
  const source = new Uint8Array(count);
  for (let i = 0; i < count; i++) source[i] = Number.isNaN(result.heights[i]) ? SOURCE_NONE : SOURCE_OWN;
  return {
    layerId,
    total,
    spacing,
    points,
    heights: result.heights,
    source,
    coverage: result.coverage,
    blocks: result.blocks,
    problems: result.problems,
  };
}

/** Height of a profile at any distance along it, by straight-line blending. */
export function heightAt(profile, distance) {
  const last = profile.heights.length - 1;
  const position = Math.min(last, Math.max(0, distance / profile.spacing));
  const i = Math.min(last - 1, Math.floor(position));
  const t = position - i;
  const h0 = profile.heights[i];
  const h1 = profile.heights[i + 1];
  if (Number.isNaN(h0)) return h1;
  if (Number.isNaN(h1)) return h0;
  return h0 * (1 - t) + h1 * t;
}

/**
 * Fill the holes in a detailed profile from a coarser one of the same path.
 * Changes the detailed profile in place and reports how many samples it filled.
 */
export function fillGaps(detailed, coarser) {
  let filled = 0;
  for (let i = 0; i < detailed.heights.length; i++) {
    if (detailed.source[i] !== SOURCE_NONE) continue;
    const h = heightAt(coarser, detailed.points[i].distance);
    if (Number.isNaN(h)) continue;
    detailed.heights[i] = h;
    detailed.source[i] = SOURCE_FILLED;
    filled += 1;
  }
  return filled;
}

/** Lowest and highest heights in a profile, ignoring holes. */
export function heightRange(heights) {
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (Number.isNaN(h)) continue;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return min === Infinity ? null : { min, max };
}

// ---------------------------------------------------------------------------
// Mixed-detail profiles: coarse data for the whole path, fine data only on the
// stretches where it changes the answer.
// ---------------------------------------------------------------------------

// Where each height in a mixed profile ("track") came from.
export const FROM_NOTHING = 0; // no data
export const FROM_10M = 1; // the 10 m draft
export const FROM_2M = 2; // the 2 m layer
export const FROM_FILL = 3; // a hole, filled from coarser data

/** How far apart 2 m samples can be while keeping the whole profile under its sample limit. */
export function detailSpacing(stretches, draftCount, maxSamples) {
  const length = stretches.reduce((sum, [from, to]) => sum + (to - from), 0);
  const budget = Math.max(200, maxSamples - draftCount);
  return Math.max(2, length / budget);
}

/** Sample positions along one stretch of a path, on the map and on the terrain grid. */
export function stretchSamples(a, b, total, from, to, spacing) {
  const count = Math.max(2, Math.round((to - from) / spacing) + 1);
  const distance = new Float64Array(count);
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  const grid = new Array(count);
  for (let i = 0; i < count; i++) {
    const d = from + ((to - from) * i) / (count - 1);
    const p = pointAlong(a, b, total > 0 ? d / total : 0);
    distance[i] = d;
    lat[i] = p.lat;
    lon[i] = p.lon;
    grid[i] = toGrid(p.lat, p.lon);
  }
  return { from, to, distance, lat, lon, grid };
}

/**
 * Read one stretch of a path from one terrain layer (the 2 m layer unless told otherwise).
 *
 * @param {{ terrain: any, a: {lat: number, lon: number}, b: {lat: number, lon: number}, total: number,
 *   from: number, to: number, spacing: number, layerId?: string,
 *   onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} options
 */
export async function sampleStretch({ terrain, a, b, total, from, to, spacing, layerId = '2m', signal, onProgress }) {
  const samples = stretchSamples(a, b, total, from, to, spacing);
  const result = await terrain.sample(layerId, samples.grid, { signal, onProgress });
  return {
    from,
    to,
    distance: samples.distance,
    lat: samples.lat,
    lon: samples.lon,
    height: result.heights,
    blocks: result.blocks,
    problems: result.problems,
  };
}

/**
 * Stitch the draft and the detailed stretches into one profile, ordered by
 * distance. Inside a detailed stretch the 2 m samples replace the draft's;
 * holes in the 2 m data are filled from the draft and marked as such.
 */
export function composeTrack(draft, stretches = []) {
  const ordered = [...stretches].sort((p, q) => p.from - q.from);
  const pieces = []; // [distance, lat, lon, height, source]
  let s = 0;
  const inside = (d) => {
    while (s < ordered.length && d > ordered[s].to) s += 1;
    return s < ordered.length && d >= ordered[s].from;
  };

  for (let i = 0; i < draft.heights.length; i++) {
    const p = draft.points[i];
    if (inside(p.distance)) continue;
    const src = draft.source[i] === SOURCE_OWN ? FROM_10M : draft.source[i] === SOURCE_FILLED ? FROM_FILL : FROM_NOTHING;
    pieces.push([p.distance, p.lat, p.lon, draft.heights[i], src]);
  }
  for (const stretch of ordered) {
    for (let i = 0; i < stretch.distance.length; i++) {
      let h = stretch.height[i];
      let src = FROM_2M;
      if (Number.isNaN(h)) {
        h = heightAt(draft, stretch.distance[i]);
        src = Number.isNaN(h) ? FROM_NOTHING : FROM_FILL;
      }
      pieces.push([stretch.distance[i], stretch.lat[i], stretch.lon[i], h, src]);
    }
  }
  pieces.sort((p, q) => p[0] - q[0]);

  // Two samples at the same distance (a stretch edge meeting a draft sample) would
  // confuse the maths later, so keep only the first of any such pair.
  const kept = pieces.filter((p, i) => i === 0 || p[0] - pieces[i - 1][0] > 1e-6);
  const n = kept.length;
  const track = {
    total: draft.total,
    distance: new Float64Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    height: new Float32Array(n),
    source: new Uint8Array(n),
  };
  kept.forEach((p, i) => {
    track.distance[i] = p[0];
    track.lat[i] = p[1];
    track.lon[i] = p[2];
    track.height[i] = p[3];
    track.source[i] = p[4];
  });
  return track;
}
