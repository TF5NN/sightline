// Reads terrain heights straight out of the ArcticDEM files.
//
// The files are huge (a 2 m file covers 50 x 50 km), but they are stored as a
// grid of small internal blocks with an index at the front. So this reader
// fetches each file's index once, then asks only for the blocks a path
// actually crosses, and keeps them in memory in case they are needed again.
//
// Nothing in here knows about radio or about the page. Give it positions on
// the map grid, get heights back. The GeoTIFF library is handed in from
// outside so the same code runs in the browser and in the automated tests.

import { DEFAULT_BASE_URL, LAYERS, areaKey, tileCandidates } from './tiles.js';

// Heights below this are treated as "no data" even if the file forgot to say so.
const LOWEST_REAL_HEIGHT = -1000;

/**
 * @param {{ GeoTIFF?: any, baseUrl?: string, maxCachedBlocks?: number, concurrency?: number, fetchImpl?: typeof fetch }} options
 */
export function createTerrain({
  GeoTIFF,
  baseUrl = DEFAULT_BASE_URL,
  maxCachedBlocks = 800,
  concurrency = 6,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!GeoTIFF) throw new Error('createTerrain needs the GeoTIFF library');

  const files = new Map(); // file address -> promise of an opened file (or a "not available" note)
  const areas = new Map(); // quarter of the grid -> promise of the files that cover it
  const blocks = new Map(); // "address#column,row" -> promise of one block of heights
  const stats = { filesOpened: 0, filesMissing: 0, filesBlocked: 0, blocksFetched: 0, blocksReused: 0 };

  // --- opening files -------------------------------------------------------

  async function describeFailure(url, error) {
    // The library could not open the file. Ask the server directly, once, to
    // learn whether the file simply does not exist (normal: sea, or south of
    // the covered area) or whether the browser was not allowed to reach it.
    try {
      const response = await fetchImpl(url, { headers: { Range: 'bytes=0-15' } });
      if (response.ok) return { available: false, reason: 'unreadable', detail: String(error) };
      return { available: false, reason: 'missing', detail: `HTTP ${response.status}` };
    } catch (probeError) {
      return { available: false, reason: 'blocked', detail: String(probeError) };
    }
  }

  function openFile(url) {
    if (files.has(url)) return files.get(url);
    const promise = (async () => {
      try {
        const tiff = await GeoTIFF.fromUrl(url);
        const image = await tiff.getImage(0);
        const [originX, originY] = image.getOrigin();
        const [stepX, stepY] = image.getResolution();
        const nodata = image.getGDALNoData();
        stats.filesOpened += 1;
        return {
          available: true,
          url,
          image,
          originX,
          originY,
          stepX, // metres per cell going right (positive)
          stepY, // metres per cell going down the file (negative: north is up)
          width: image.getWidth(),
          height: image.getHeight(),
          blockWidth: image.getTileWidth(),
          blockHeight: image.getTileHeight(),
          nodata: nodata === null || Number.isNaN(nodata) ? null : nodata,
        };
      } catch (error) {
        const failure = await describeFailure(url, error);
        if (failure.reason === 'blocked') stats.filesBlocked += 1;
        else stats.filesMissing += 1;
        return { ...failure, url };
      }
    })();
    files.set(url, promise);
    return promise;
  }

  function cellOf(file, x, y) {
    // Position measured in cells from the file's top-left corner.
    return { cx: (x - file.originX) / file.stepX, cy: (y - file.originY) / file.stepY };
  }

  function covers(file, x, y) {
    const { cx, cy } = cellOf(file, x, y);
    return cx >= 0 && cx < file.width && cy >= 0 && cy < file.height;
  }

  /** Every file that could hold positions in this quarter of the grid. */
  function filesForArea(layerId, x, y) {
    const key = areaKey(layerId, x, y);
    if (!areas.has(key)) {
      areas.set(
        key,
        (async () => {
          const opened = [];
          for (const candidate of tileCandidates(layerId, x, y, baseUrl)) {
            const file = await openFile(candidate.url);
            opened.push(file);
            // Stop at the first real file that contains the position we were asked about.
            if (file.available && covers(file, x, y)) break;
          }
          return opened;
        })(),
      );
    }
    return areas.get(key);
  }

  // --- reading blocks ------------------------------------------------------

  function loadBlock(file, bx, by, signal) {
    const key = `${file.url}#${bx},${by}`;
    if (blocks.has(key)) {
      // Move to the back of the queue: recently used blocks are kept longest.
      const existing = blocks.get(key);
      blocks.delete(key);
      blocks.set(key, existing);
      stats.blocksReused += 1;
      return existing;
    }
    const left = bx * file.blockWidth;
    const top = by * file.blockHeight;
    const right = Math.min(left + file.blockWidth, file.width);
    const bottom = Math.min(top + file.blockHeight, file.height);
    const promise = file.image
      .readRasters({ window: [left, top, right, bottom], samples: [0], signal })
      .then((rasters) => ({ data: rasters[0], left, top, width: right - left, height: bottom - top }))
      .catch((error) => {
        blocks.delete(key); // do not remember a failed download
        throw error;
      });
    blocks.set(key, promise);
    stats.blocksFetched += 1;
    while (blocks.size > maxCachedBlocks) blocks.delete(blocks.keys().next().value);
    return promise;
  }

  async function runLimited(jobs, limit, onEach) {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
        done += 1;
        if (onEach) onEach(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  }

  // --- planning and sampling ----------------------------------------------

  /** Work out, for each position, which file and which four cells it needs. */
  async function plan(layerId, gridPoints) {
    if (!LAYERS[layerId]) throw new Error(`Unknown terrain layer: ${layerId}`);
    // Open every file the path touches, in parallel.
    const areaFiles = new Map();
    for (const p of gridPoints) {
      const key = areaKey(layerId, p.x, p.y);
      if (!areaFiles.has(key)) areaFiles.set(key, filesForArea(layerId, p.x, p.y));
    }
    const resolved = new Map();
    await Promise.all(
      [...areaFiles].map(async ([key, promise]) => resolved.set(key, await promise)),
    );

    const lookups = new Array(gridPoints.length);
    const needed = new Map(); // block key -> { file, bx, by }
    const problems = { missing: 0, blocked: 0, unreadable: 0 };
    const filesUsed = new Set();

    gridPoints.forEach((p, index) => {
      const candidates = resolved.get(areaKey(layerId, p.x, p.y));
      const file = candidates.find((f) => f.available && covers(f, p.x, p.y));
      if (!file) {
        const why = candidates.find((f) => !f.available);
        problems[why ? why.reason : 'missing'] += 1;
        lookups[index] = null;
        return;
      }
      filesUsed.add(file.url);
      // Cell centres sit half a cell in from the corner, hence the 0.5.
      const { cx, cy } = cellOf(file, p.x, p.y);
      const fx = cx - 0.5;
      const fy = cy - 0.5;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const cells = [
        [i0, j0],
        [i0 + 1, j0],
        [i0, j0 + 1],
        [i0 + 1, j0 + 1],
      ].map(([i, j]) => [
        Math.min(file.width - 1, Math.max(0, i)),
        Math.min(file.height - 1, Math.max(0, j)),
      ]);
      for (const [i, j] of cells) {
        const bx = Math.floor(i / file.blockWidth);
        const by = Math.floor(j / file.blockHeight);
        const key = `${file.url}#${bx},${by}`;
        if (!needed.has(key)) needed.set(key, { file, bx, by });
      }
      lookups[index] = { file, cells, tx: fx - i0, ty: fy - j0 };
    });

    return { lookups, needed, problems, filesUsed };
  }

  /**
   * How much a path would cost to load: number of blocks, how many are
   * already in memory, and the download size of the rest in bytes.
   */
  async function estimate(layerId, gridPoints) {
    const { needed, problems } = await plan(layerId, gridPoints);
    let bytes = 0;
    let toFetch = 0;
    const sizeTables = new Map();
    for (const [key, { file, bx, by }] of needed) {
      if (blocks.has(key)) continue;
      toFetch += 1;
      if (!sizeTables.has(file.url)) {
        // The file's index lists the stored size of every block.
        let table = null;
        try {
          table = await file.image.fileDirectory.loadValue('TileByteCounts');
        } catch {
          table = null;
        }
        sizeTables.set(file.url, table);
      }
      const table = sizeTables.get(file.url);
      if (table) {
        const across = Math.ceil(file.width / file.blockWidth);
        bytes += Number(table[by * across + bx] ?? 0);
      }
    }
    return { blocks: needed.size, blocksToFetch: toFetch, bytesToFetch: bytes, problems };
  }

  /**
   * Heights for a list of grid positions. Positions with no data come back
   * as NaN (not-a-number), never as zero, so a hole can't pass for sea level.
   *
   * @param {string} layerId
   * @param {{x: number, y: number}[]} gridPoints
   * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [options]
   */
  async function sample(layerId, gridPoints, { onProgress, signal } = {}) {
    const { lookups, needed, problems, filesUsed } = await plan(layerId, gridPoints);

    const loaded = new Map();
    const jobs = [...needed].map(([key, { file, bx, by }]) => async () => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      loaded.set(key, await loadBlock(file, bx, by, signal));
    });
    await runLimited(jobs, concurrency, onProgress);

    const valueAt = (file, i, j) => {
      const bx = Math.floor(i / file.blockWidth);
      const by = Math.floor(j / file.blockHeight);
      const block = loaded.get(`${file.url}#${bx},${by}`);
      const v = block.data[(j - block.top) * block.width + (i - block.left)];
      if (!Number.isFinite(v) || v === file.nodata || v < LOWEST_REAL_HEIGHT) return NaN;
      return v;
    };

    const heights = new Float32Array(gridPoints.length);
    let valid = 0;
    lookups.forEach((lookup, index) => {
      if (!lookup) {
        heights[index] = NaN;
        return;
      }
      const { file, cells, tx, ty } = lookup;
      const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      // Blend the four surrounding cells. If some are holes, blend the rest.
      let sum = 0;
      let weightSum = 0;
      for (let k = 0; k < 4; k++) {
        const v = valueAt(file, cells[k][0], cells[k][1]);
        if (!Number.isNaN(v) && weights[k] > 0) {
          sum += v * weights[k];
          weightSum += weights[k];
        }
      }
      heights[index] = weightSum > 0 ? sum / weightSum : NaN;
      if (weightSum > 0) valid += 1;
    });

    return {
      heights,
      coverage: gridPoints.length ? valid / gridPoints.length : 0,
      blocks: needed.size,
      files: filesUsed.size,
      problems,
    };
  }

  return { sample, estimate, stats, baseUrl };
}
