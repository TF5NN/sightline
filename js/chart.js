// Draws the profile chart: terrain, line of sight, Fresnel zone and the
// problem spots. Knows about Plotly and nothing else.
//
// Reading the profile is done here rather than by Plotly, so that it works the
// same with a mouse and with a finger: move along the chart and a line follows,
// and the page is told which sample is under it. On a touch screen the line
// stays where the finger left it.

// The chart's colours are the page's named shades (css/style.css), read each time it is drawn so
// that it follows the light or dark theme. The values here are used where there is no page.
const FALLBACK = { ink: '#203b3d', line: '#dfe5de', green: '#267c62', path: '#2f6fb7', bad: '#c0392b', marginal: '#d98a00' };

/** A named shade as the page has it now: "#rrggbb". */
function shade(name) {
  const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : FALLBACK[name];
}

/** The same shade, see-through: "rgba(r,g,b,alpha)". */
function wash(name, alpha) {
  const hex = shade(name);
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}

/** Narrow charts (phones) get tighter margins and no title on the height axis. */
export const isCompact = (element) => element.clientWidth > 0 && element.clientWidth < 520;

const gapsToNull = (values) => Array.from(values, (v) => (Number.isFinite(v) ? v : null));

/**
 * Draw (or redraw) the chart.
 *
 * view = {
 *   km:       distance from A for each sample, in kilometres
 *   terrain:  ground height with the Earth's bulge added (NaN = no data)
 *   los:      height of the line of sight at each sample
 *   fresnel:  radius of the first Fresnel zone at each sample
 *   status:   per sample; 1 = grazing (inside 60% of the Fresnel zone), 2 = above the line of sight
 *   showGrazing: draw the grazing stretches in amber (off unless asked for)
 *   showFresnel: draw the Fresnel zone (off unless asked for)
 *   edges:    [{ km, height, loss }] diffraction edges to label (optional)
 *   masts:    { baseA, tipA, baseB, tipB }
 * }
 * Any of los / fresnel / status / edges / masts may be missing: then only the
 * terrain is drawn.
 */
export function drawProfile(Plotly, element, view, { onHover, onLeave } = {}) {
  const n = view.km.length;
  const terrain = gapsToNull(view.terrain);
  const hasLink = Boolean(view.los);

  let low = Infinity;
  let high = -Infinity;
  for (const h of terrain) {
    if (h === null) continue;
    if (h < low) low = h;
    if (h > high) high = h;
  }
  if (low === Infinity) {
    low = 0;
    high = 100;
  }
  const showFresnel = hasLink && Boolean(view.showFresnel);
  let ceiling = high;
  if (hasLink) {
    for (let i = 0; i < n; i++) {
      const upper = view.los[i] + (showFresnel ? view.fresnel[i] : 0);
      if (Number.isFinite(upper) && upper > ceiling) ceiling = upper;
    }
  }
  const pad = Math.max(10, (ceiling - low) * 0.08);
  // The terrain fill reaches down to an invisible floor just below the lowest ground.
  const floor = Math.floor((low - pad) / 10) * 10;
  const quiet = { hoverinfo: 'skip', showlegend: false };

  const traces = [
    { x: view.km, y: view.km.map(() => floor), mode: 'lines', line: { width: 0 }, ...quiet },
    {
      x: view.km,
      y: terrain,
      mode: 'lines',
      line: { color: shade('green'), width: 1.5 },
      fill: 'tonexty',
      fillcolor: wash('green', 0.16),
      connectgaps: false,
      ...quiet,
    },
  ];

  if (hasLink) {
    // Ground above the line of sight is drawn in red.
    const blocked = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      // Colour a sample and its neighbours, so a single bad sample still shows as a short line.
      if (view.status[i] === 2) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) blocked[j] = terrain[j];
    }
    // Ground that comes close to the line of sight (inside 60% of the Fresnel zone) in amber, when asked for.
    const grazing = new Array(n).fill(null);
    if (view.showGrazing) {
      for (let i = 0; i < n; i++) {
        if (view.status[i] === 1) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) grazing[j] = terrain[j];
      }
    }
    if (showFresnel) {
      const lower = new Array(n);
      const upper = new Array(n);
      const sixty = new Array(n);
      for (let i = 0; i < n; i++) {
        lower[i] = view.los[i] - view.fresnel[i];
        upper[i] = view.los[i] + view.fresnel[i];
        sixty[i] = view.los[i] - 0.6 * view.fresnel[i];
      }
      traces.push(
        { x: view.km, y: lower, mode: 'lines', line: { color: wash('path', 0.45), width: 1 }, ...quiet },
        {
          x: view.km,
          y: upper,
          mode: 'lines',
          line: { color: wash('path', 0.45), width: 1 },
          fill: 'tonexty',
          fillcolor: wash('path', 0.13),
          ...quiet,
        },
        { x: view.km, y: sixty, mode: 'lines', line: { color: wash('path', 0.6), width: 1, dash: 'dot' }, ...quiet },
      );
    }
    traces.push(
      { x: view.km, y: Array.from(view.los), mode: 'lines', line: { color: shade('path'), width: 1.75 }, ...quiet },
      { x: view.km, y: grazing, mode: 'lines', line: { color: shade('marginal'), width: 3.5 }, connectgaps: false, ...quiet },
      { x: view.km, y: blocked, mode: 'lines', line: { color: shade('bad'), width: 3.5 }, connectgaps: false, ...quiet },
    );
    if (view.masts) {
      const end = view.km[n - 1];
      traces.push({
        x: [0, 0, null, end, end],
        y: [view.masts.baseA, view.masts.tipA, null, view.masts.baseB, view.masts.tipB],
        mode: 'lines',
        line: { color: shade('ink'), width: 3 },
        ...quiet,
      });
    }
    if (view.edges?.length) {
      traces.push({
        x: view.edges.map((e) => e.km),
        y: view.edges.map((e) => e.height),
        text: view.edges.map((e) => `−${e.loss.toFixed(0)} dB`),
        mode: 'markers+text',
        textposition: 'top center',
        textfont: { size: 11, color: shade('ink') },
        marker: { symbol: 'triangle-down', size: 9, color: shade('ink') },
        cliponaxis: false,
        ...quiet,
      });
    }
  }

  const compact = isCompact(element);
  const layout = {
    margin: compact ? { l: 38, r: 6, t: 16, b: 36 } : { l: 54, r: 12, t: 18, b: 42 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: "'DM Sans', Arial, sans-serif", size: compact ? 11 : 12, color: shade('ink') },
    hovermode: false,
    dragmode: false,
    xaxis: {
      title: { text: 'Distance from A (km)', standoff: compact ? 6 : 10 },
      range: [0, view.km[n - 1]],
      gridcolor: shade('line'),
      zeroline: false,
      fixedrange: true,
      nticks: compact ? 6 : 12,
    },
    yaxis: {
      title: compact ? undefined : { text: 'Height (m)' },
      range: [floor, ceiling + pad],
      gridcolor: shade('line'),
      zeroline: false,
      fixedrange: true,
      nticks: compact ? 6 : 8,
    },
  };

  const config = { displayModeBar: false, responsive: true, scrollZoom: false, doubleClick: false };

  Plotly.react(element, traces, layout, config);

  // What the reading line needs to know about this drawing.
  const before = element._sightline;
  element._sightline = { km: view.km, terrain, n, onHover, onLeave, atKm: null };
  attachReading(element);
  // If the line was showing (pointer resting on the chart, or left there by a
  // finger), put it back at the same distance on the new drawing.
  if (before && before.atKm !== null) showAt(element, Math.min(before.atKm, view.km[n - 1]));
  else hideCursor(element);
}

/** Index of the sample nearest to a distance. The samples are in order but not evenly spaced. */
function nearestIndex(km, target) {
  let low = 0;
  let high = km.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (km[middle] < target) low = middle;
    else high = middle;
  }
  return target - km[low] <= km[high] - target ? low : high;
}

function cursorOf(element) {
  let cursor = element.querySelector(':scope > .chart-cursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.className = 'chart-cursor';
    cursor.hidden = true;
    cursor.append(document.createElement('i'));
    element.append(cursor);
  }
  return cursor;
}

function hideCursor(element) {
  cursorOf(element).hidden = true;
}

/** Put the reading line at a distance along the path and tell the page which sample that is. */
function showAt(element, targetKm) {
  const state = element._sightline;
  const size = element._fullLayout?._size;
  if (!state || !size) return;
  const total = state.km[state.n - 1];
  const index = nearestIndex(state.km, targetKm);
  state.atKm = state.km[index];

  const cursor = cursorOf(element);
  cursor.style.left = `${size.l + (state.km[index] / total) * size.w}px`;
  cursor.style.top = `${size.t}px`;
  cursor.style.height = `${size.h}px`;
  const dot = cursor.firstElementChild;
  const y = state.terrain[index] === null ? NaN : element._fullLayout.yaxis?.l2p?.(state.terrain[index]);
  dot.hidden = !Number.isFinite(y);
  if (Number.isFinite(y)) dot.style.top = `${y}px`;
  cursor.hidden = false;
  state.onHover?.(index);
}

/** Listen for the pointer or a finger on the chart. Done once per chart element. */
function attachReading(element) {
  if (element._sightlineReading) return;
  element._sightlineReading = true;
  // A slip in here must never be able to break the chart or a download, so each handler is fenced off.
  const safely = (handler) => (event) => {
    try {
      handler(event);
    } catch (error) {
      console.warn('Chart reading failed', error);
    }
  };
  const follow = safely((event) => {
    const state = element._sightline;
    const size = element._fullLayout?._size;
    if (!state || !size) return;
    const x = event.clientX - element.getBoundingClientRect().left - size.l;
    const fraction = Math.min(1, Math.max(0, x / size.w));
    showAt(element, fraction * state.km[state.n - 1]);
  });
  const leave = safely((event) => {
    // A finger lifting off leaves the reading in place; a mouse leaving clears it.
    if (event.pointerType !== 'mouse') return;
    const state = element._sightline;
    if (state) state.atKm = null;
    hideCursor(element);
    state?.onLeave?.();
  });
  element.addEventListener('pointerdown', follow);
  element.addEventListener('pointermove', follow);
  element.addEventListener('pointerleave', leave);
}

export function clearProfile(Plotly, element) {
  element._sightline = null;
  hideCursor(element);
  Plotly.purge(element);
}
