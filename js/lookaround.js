// The look-around view: the terrain's skyline as seen from point A, with the
// stations and point B marked where they stand. Dragging (or the arrow keys)
// turns the view. This file draws into an <svg> it is given; the maths is in
// panorama.js and the skyline comes from the shared terrain layers (sight.js).

import { compass, frame, ground, horizonAngle, line, project } from './panorama.js';

const WIDTH = 400;
const HEIGHT = 300;
const MAX_PITCH = 75;
const view = frame(WIDTH, HEIGHT);
const turn = (degrees) => ((degrees % 360) + 360) % 360;
const escape = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const ring = (el) => Array.from({ length: 121 }, (_, i) => ({ az: i * 3, el }));
const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * @typedef {{ az: number, el: number, label: string, kind: 'good' | 'marginal' | 'blocked' | 'b' }} Mark
 *   something to point out: a station (coloured by whether A can see it) or point B
 */

/**
 * The picture for one direction of view, as SVG markup.
 * @param {{ yaw: number, pitch: number }} camera
 * @param {{ angles: ArrayLike<number>, stepDegrees: number }} horizon
 * @param {Mark[]} marks
 */
export function picture(camera, horizon, marks) {
  const at = (az, el, margin = 30) => {
    const p = project(camera, view, az, el);
    return p && p[0] > -margin && p[0] < WIDTH + margin && p[1] > -margin && p[1] < HEIGHT + margin ? p : null;
  };
  const parts = [`<rect width="${WIDTH}" height="${HEIGHT}" class="look-sky"/>`];
  for (const el of [30, 60]) parts.push(`<path d="${line(camera, view, ring(el))}" class="look-grid" stroke-dasharray="3 4"/>`);
  for (const az of [0, 90, 180, 270]) {
    parts.push(`<path d="${line(camera, view, Array.from({ length: 31 }, (_, i) => ({ az, el: i * 3 })))}" class="look-grid"/>`);
    const high = at(az, 76);
    if (high) parts.push(`<text x="${(high[0] + 3).toFixed(1)}" y="${high[1].toFixed(1)}" class="look-degree">${CARDINAL[az / 45]}</text>`);
  }
  for (const el of [30, 60]) {
    const p = at(camera.yaw, el);
    if (p) parts.push(`<text x="${(p[0] + 4).toFixed(1)}" y="${(p[1] - 3).toFixed(1)}" class="look-degree">${el}°</text>`);
  }
  parts.push(`<path d="${ground(camera, view, horizon)}" class="look-ground"/>`, `<path d="${line(camera, view, ring(0))}" class="look-level"/>`);
  for (let az = 0; az < 360; az += 15) {
    const a = at(az, 0);
    const b = at(az, -1.5);
    const label = at(az, -5);
    if (!a || !b) continue;
    parts.push(`<path d="M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}" class="look-tick"/>`);
    if (label) {
      const main = az % 45 === 0;
      parts.push(`<text x="${label[0].toFixed(1)}" y="${(label[1] + 3).toFixed(1)}" text-anchor="middle" class="${main ? 'look-cardinal' : 'look-bearing'}">${main ? CARDINAL[az / 45] : `${az}°`}</text>`);
    }
  }
  // Stations and point B: a stalk from the skyline (or the level line) to a dot, with a name.
  // A blocked one is drawn where it stands, behind the ground, so the direction is still shown.
  const placed = [];
  for (const mark of marks) {
    const p = at(mark.az, mark.el, 0);
    if (!p) continue;
    const top = Math.min(p[1], at(mark.az, Math.max(mark.el, horizonAngle(horizon, mark.az)), 60)?.[1] ?? p[1]);
    placed.push({ mark, p, x: Math.max(24, Math.min(WIDTH - 24, p[0])), y: top - 9 });
  }
  // Names that would run into each other are stepped upwards, left to right.
  placed.sort((a, b) => a.x - b.x);
  placed.forEach((item, i) => {
    for (let lift = 0; lift < 4; lift++) {
      const y = item.y - lift * 9;
      if (!placed.slice(0, i).some((other) => Math.abs(other.x - item.x) < (other.mark.label.length + item.mark.label.length) * 2.2 + 4 && Math.abs(other.y - y) < 8)) {
        item.y = y;
        break;
      }
    }
  });
  for (const { mark, p, x, y } of placed) {
    parts.push(
      `<g class="look-mark look-${mark.kind}">` +
        `<path d="M${p[0].toFixed(1)},${p[1].toFixed(1)}V${(y + 3).toFixed(1)}"/>` +
        `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5"/>` +
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escape(mark.label)}</text>` +
        '</g>',
    );
  }
  return parts.join('');
}

/** One line under the picture: which way the view faces. */
export const facingWords = (camera) => `Looking ${compass(camera.yaw)} · ${Math.round(camera.yaw) % 360}° · ${Math.round(camera.pitch)}° up`;

/**
 * Make an <svg> into a look-around view.
 * @param {SVGSVGElement} svg
 * @param {HTMLElement} facing where "Looking NNE · 20° · 10° up" is written
 * @returns {{ show: (horizon: object, marks: Mark[], yaw: number) => void }}
 */
export function createLookAround(svg, facing) {
  let camera = { yaw: 0, pitch: 12 };
  let horizon = null;
  let marks = [];
  let drag = null;
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);

  function draw() {
    if (!horizon) return;
    svg.innerHTML = picture(camera, horizon, marks);
    facing.textContent = facingWords(camera);
    svg.setAttribute('aria-label', `View from point A towards ${compass(camera.yaw)}, tilted ${Math.round(camera.pitch)} degrees up. Drag or use the arrow keys to look around.`);
  }
  const move = (yaw, pitch) => {
    camera = { yaw: turn(yaw), pitch: Math.max(0, Math.min(MAX_PITCH, pitch)) };
    draw();
  };
  svg.addEventListener('pointerdown', (event) => {
    svg.setPointerCapture(event.pointerId);
    // Degrees turned per pixel dragged, so the scene follows the finger near the centre.
    const perPixel = (WIDTH / svg.getBoundingClientRect().width / view.scale) * (180 / Math.PI);
    drag = { x: event.clientX, y: event.clientY, camera, perPixel };
  });
  svg.addEventListener('pointermove', (event) => {
    if (drag) move(drag.camera.yaw - (event.clientX - drag.x) * drag.perPixel, drag.camera.pitch + (event.clientY - drag.y) * drag.perPixel);
  });
  for (const type of ['pointerup', 'pointercancel']) svg.addEventListener(type, () => (drag = null));
  svg.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[event.key];
    if (!step) return;
    event.preventDefault();
    move(camera.yaw + step[0], camera.pitch + step[1]);
  });

  return {
    show(newHorizon, newMarks, yaw) {
      horizon = newHorizon;
      marks = newMarks;
      move(yaw, 12);
    },
  };
}
