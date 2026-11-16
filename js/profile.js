// Builds a terrain profile: the heights along the straight path between two
// points. Sits between the map (which knows the waypoints) and the terrain
// reader (which knows the files).

import { geodesicDistance, samplePath } from './geo.js';
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
