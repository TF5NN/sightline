// Draws the profile chart: terrain, line of sight, Fresnel zone and the
// problem spots. Knows about Plotly and nothing else.

const INK = '#203b3d';
const LINE = '#dfe5de';
const GREEN = '#267c62';
const BLUE = '#2f6fb7';
const AMBER = '#d98a00';
const RED = '#c0392b';

const gapsToNull = (values) => Array.from(values, (v) => (Number.isFinite(v) ? v : null));

/**
 * Draw (or redraw) the chart.
 *
 * view = {
 *   km:       distance from A for each sample, in kilometres
 *   terrain:  ground height with the Earth's bulge added (NaN = no data)
 *   los:      height of the line of sight at each sample
 *   fresnel:  radius of the first Fresnel zone at each sample
 *   status:   0 clear, 1 grazing, 2 blocked, per sample
 *   edges:    [{ km, height, loss }] diffraction edges
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
  let ceiling = high;
  if (hasLink) {
    for (let i = 0; i < n; i++) {
      const upper = view.los[i] + view.fresnel[i];
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
      line: { color: GREEN, width: 1.5 },
      fill: 'tonexty',
      fillcolor: 'rgba(38,124,98,0.16)',
      connectgaps: false,
      hovertemplate: '%{x:.2f} km<extra></extra>',
      showlegend: false,
    },
  ];

  if (hasLink) {
    const lower = new Array(n);
    const upper = new Array(n);
    const sixty = new Array(n);
    const grazing = new Array(n).fill(null);
    const blocked = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      lower[i] = view.los[i] - view.fresnel[i];
      upper[i] = view.los[i] + view.fresnel[i];
      sixty[i] = view.los[i] - 0.6 * view.fresnel[i];
      // Colour a sample and its neighbours, so a single bad sample still shows as a short line.
      if (view.status[i] === 1 || view.status[i] === 2) {
        const target = view.status[i] === 2 ? blocked : grazing;
        for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) target[j] = terrain[j];
      }
    }
    traces.push(
      { x: view.km, y: lower, mode: 'lines', line: { color: 'rgba(47,111,183,0.45)', width: 1 }, ...quiet },
      {
        x: view.km,
        y: upper,
        mode: 'lines',
        line: { color: 'rgba(47,111,183,0.45)', width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(47,111,183,0.13)',
        ...quiet,
      },
      { x: view.km, y: sixty, mode: 'lines', line: { color: 'rgba(47,111,183,0.6)', width: 1, dash: 'dot' }, ...quiet },
      { x: view.km, y: Array.from(view.los), mode: 'lines', line: { color: BLUE, width: 1.75 }, ...quiet },
      { x: view.km, y: grazing, mode: 'lines', line: { color: AMBER, width: 3.5 }, connectgaps: false, ...quiet },
      { x: view.km, y: blocked, mode: 'lines', line: { color: RED, width: 3.5 }, connectgaps: false, ...quiet },
    );
    if (view.masts) {
      const end = view.km[n - 1];
      traces.push({
        x: [0, 0, null, end, end],
        y: [view.masts.baseA, view.masts.tipA, null, view.masts.baseB, view.masts.tipB],
        mode: 'lines',
        line: { color: INK, width: 3 },
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
        textfont: { size: 11, color: INK },
        marker: { symbol: 'triangle-down', size: 9, color: INK },
        cliponaxis: false,
        ...quiet,
      });
    }
  }

  const layout = {
    margin: { l: 54, r: 12, t: 18, b: 42 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: "'DM Sans', Arial, sans-serif", size: 12, color: INK },
    hovermode: 'x',
    dragmode: false,
    xaxis: {
      title: { text: 'Distance from A (km)' },
      range: [0, view.km[n - 1]],
      gridcolor: LINE,
      zeroline: false,
      fixedrange: true,
    },
    yaxis: {
      title: { text: hasLink ? 'Height (m), Earth curve included' : 'Height above sea level (m)' },
      range: [floor, ceiling + pad],
      gridcolor: LINE,
      zeroline: false,
      fixedrange: true,
    },
  };

  const config = { displayModeBar: false, responsive: true, scrollZoom: false, doubleClick: false };

  // Take the old listeners off BEFORE redrawing. If the pointer is resting on
  // the chart, Plotly sends a fresh "hover" in the middle of the redraw, and an
  // old listener would receive positions that belong to the new profile.
  element.removeAllListeners?.('plotly_hover');
  element.removeAllListeners?.('plotly_unhover');

  Plotly.react(element, traces, layout, config);

  // A slip in a hover handler must never be able to break the chart or a download,
  // so each one is fenced off.
  const safely = (handler) => (event) => {
    try {
      handler(event);
    } catch (error) {
      console.warn('Chart hover handler failed', error);
    }
  };
  if (onHover) {
    element.on(
      'plotly_hover',
      safely((event) => {
        const point = event.points.find((p) => p.curveNumber === 1) ?? event.points[0];
        if (point && Number.isInteger(point.pointIndex) && point.pointIndex < n) onHover(point.pointIndex);
      }),
    );
  }
  if (onLeave) element.on('plotly_unhover', safely(onLeave));
}

export function clearProfile(Plotly, element) {
  Plotly.purge(element);
}
