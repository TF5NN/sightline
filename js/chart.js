// Draws the terrain profile chart. Knows about Plotly and nothing else.

const INK = '#203b3d';
const MUTED = '#76847d';
const LINE = '#dfe5de';
const GREEN = '#267c62';
const AMBER = '#b7791f';

/**
 * Draw (or redraw) a profile.
 *
 * view = {
 *   km:      distance from A for each sample, in kilometres
 *   heights: height above sea level for each sample, in metres (NaN = no data)
 *   filled:  true where a hole was filled from coarser data
 *   draft:   true while only the coarse first pass is showing
 * }
 */
export function drawProfile(Plotly, element, view, { onHover, onLeave } = {}) {
  const colour = view.draft ? MUTED : GREEN;

  // Plotly wants "null" for a gap in a line.
  const heights = Array.from(view.heights, (h) => (Number.isNaN(h) ? null : h));
  const filledOnly = heights.map((h, i) => (view.filled[i] ? h : null));

  let low = Infinity;
  let high = -Infinity;
  for (const h of heights) {
    if (h === null) continue;
    if (h < low) low = h;
    if (h > high) high = h;
  }
  if (low === Infinity) {
    low = 0;
    high = 100;
  }
  const pad = Math.max(10, (high - low) * 0.08);
  // The fill reaches down to an invisible floor just below the lowest ground.
  const floor = Math.floor((low - pad) / 10) * 10;

  const traces = [
    {
      x: view.km,
      y: view.km.map(() => floor),
      mode: 'lines',
      line: { width: 0 },
      hoverinfo: 'skip',
      showlegend: false,
    },
    {
      x: view.km,
      y: heights,
      mode: 'lines',
      line: { color: colour, width: view.draft ? 1.25 : 1.75 },
      fill: 'tonexty',
      fillcolor: view.draft ? 'rgba(118,132,125,0.14)' : 'rgba(38,124,98,0.16)',
      connectgaps: false,
      hovertemplate: '%{x:.2f} km · %{y:.0f} m<extra></extra>',
      showlegend: false,
    },
    {
      // Stretches filled from coarser data, drawn dashed on top.
      x: view.km,
      y: filledOnly,
      mode: 'lines',
      line: { color: AMBER, width: 2, dash: 'dot' },
      connectgaps: false,
      hoverinfo: 'skip',
      showlegend: false,
    },
  ];

  const layout = {
    margin: { l: 54, r: 10, t: 6, b: 42 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: "'DM Sans', Arial, sans-serif", size: 12, color: INK },
    hovermode: 'x',
    dragmode: false,
    xaxis: {
      title: { text: 'Distance from A (km)' },
      range: [0, view.km[view.km.length - 1]],
      gridcolor: LINE,
      zeroline: false,
      fixedrange: true,
    },
    yaxis: {
      title: { text: 'Height above sea level (m)' },
      range: [floor, high + pad],
      gridcolor: LINE,
      zeroline: false,
      fixedrange: true,
    },
  };

  const config = { displayModeBar: false, responsive: true, scrollZoom: false, doubleClick: false };

  // Take the old listeners off BEFORE redrawing. If the pointer is resting on
  // the chart, Plotly sends a fresh "hover" in the middle of the redraw, and an
  // old listener would receive positions that belong to the new, longer profile.
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
        if (point && Number.isInteger(point.pointIndex) && point.pointIndex < view.km.length) {
          onHover(point.pointIndex);
        }
      }),
    );
  }
  if (onLeave) element.on('plotly_unhover', safely(onLeave));
}

export function clearProfile(Plotly, element) {
  Plotly.purge(element);
}
