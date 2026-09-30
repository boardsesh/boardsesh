// Closed-form motion helpers for the showcase stage. Every function here is a
// pure function of its arguments: no Date, no Math.random, no DOM. The renderer
// calls `renderAt(frame)` in any order (stills jump straight to a frame), so
// nothing may depend on the previous frame.

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (from, to, amount) => from + (to - from) * amount;

/** 0 before `start`, 1 after `start + duration`, linear in between. */
export const progress = (frame, start, duration) =>
  duration <= 0 ? (frame >= start ? 1 : 0) : clamp((frame - start) / duration);

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` as a function of linear time. Solves x(t)
 * with a fixed number of Newton steps, then bisection, so the answer is the
 * same on every call.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const bezier = (t, p1, p2) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  const slope = (t, p1, p2) => 3 * (1 - t) * (1 - t) * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t * t * (1 - p2);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let step = 0; step < 8; step += 1) {
      const error = bezier(t, x1, x2) - x;
      const derivative = slope(t, x1, x2);
      if (Math.abs(error) < 1e-7) return bezier(t, y1, y2);
      if (Math.abs(derivative) < 1e-6) break;
      t -= error / derivative;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let step = 0; step < 32; step += 1) {
      const estimate = bezier(t, x1, x2);
      if (Math.abs(estimate - x) < 1e-7) break;
      if (estimate < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return bezier(t, y1, y2);
  };
}

/** `ease.out` in the brag-slim spec: cubic-bezier(0.16, 1, 0.3, 1). */
export const easeOut = cubicBezier(0.16, 1, 0.3, 1);
export const easeInOut = cubicBezier(0.65, 0, 0.35, 1);
export const easeIn = cubicBezier(0.5, 0, 0.75, 0);

/**
 * Step response of a damped spring released from 0 towards 1, `seconds` after
 * release. `period` is the undamped natural period. Under-damped for zeta < 1.
 */
export function spring(seconds, { zeta = 0.78, period = 0.55 } = {}) {
  if (seconds <= 0) return 0;
  const omega = (2 * Math.PI) / period;
  if (zeta >= 1) return 1 - Math.exp(-omega * seconds) * (1 + omega * seconds);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * seconds);
  return 1 - decay * (Math.cos(damped * seconds) + ((zeta * omega) / damped) * Math.sin(damped * seconds));
}

/** Spring from `from` to `to`, released at `startFrame`. */
export const springAt = (frame, startFrame, fps, options) => spring((frame - startFrame) / fps, options);

// --- colour --------------------------------------------------------------

const srgbToLinear = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (channel) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.max(0, channel) ** (1 / 2.4) - 0.055;

export function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.replace(/(.)/g, '$1$1') : value;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
}

export function rgbToOklab([red, green, blue]) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([lightness, a, b]) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => clamp(linearToSrgb(channel)));
}

/** Mix two hex colours in OKLab; returns an `rgb()` string. */
export function mixOklab(fromHex, toHex, amount) {
  const from = rgbToOklab(hexToRgb(fromHex));
  const to = rgbToOklab(hexToRgb(toHex));
  const [red, green, blue] = oklabToRgb(from.map((value, index) => lerp(value, to[index], amount)));
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
}

// --- phone projection ----------------------------------------------------

const DEG = Math.PI / 180;

/**
 * Where a point on the phone lands on the canvas. `(x, y)` is relative to the
 * phone's centre in unscaled phone pixels. Mirrors the CSS the stage applies:
 * `transform: scale(s) rotateX(rx) rotateY(ry) rotateZ(rz)` about the phone's
 * centre, placed at (cx, cy), under `perspective: <perspective>px` whose origin
 * is the canvas centre. `scripts/lib/showcase-video/render.ts` has the same
 * mapping for Node; a test holds the two together.
 */
export function projectPoint(pose, x, y, { perspective, originX, originY }) {
  const scale = pose.scale ?? 1;
  const rz = (pose.rz ?? 0) * DEG;
  const ry = (pose.ry ?? 0) * DEG;
  const rx = (pose.rx ?? 0) * DEG;
  // rotateZ
  let px = x * Math.cos(rz) - y * Math.sin(rz);
  let py = x * Math.sin(rz) + y * Math.cos(rz);
  let pz = 0;
  // rotateY
  const yx = px * Math.cos(ry) + pz * Math.sin(ry);
  const yz = -px * Math.sin(ry) + pz * Math.cos(ry);
  px = yx;
  pz = yz;
  // rotateX
  const xy = py * Math.cos(rx) - pz * Math.sin(rx);
  const xz = py * Math.sin(rx) + pz * Math.cos(rx);
  py = xy;
  pz = xz;
  // scale, then place
  const worldX = pose.cx + px * scale;
  const worldY = pose.cy + py * scale;
  const worldZ = pz * scale;
  const factor = perspective / (perspective - worldZ);
  return { x: originX + (worldX - originX) * factor, y: originY + (worldY - originY) * factor };
}

// --- anchors -------------------------------------------------------------

/** The sample in force at `t` seconds: the last at or before `t`, else the first. Same rule as contract.ts. */
export function anchorAt(samples, t) {
  if (!samples || samples.length === 0) return null;
  let current = samples[0];
  for (const sample of samples) {
    if (sample.t <= t) current = sample;
    else break;
  }
  return current;
}

// --- curves --------------------------------------------------------------

/**
 * Centripetal-free (uniform) Catmull-Rom through `points`, sampled into a dense
 * polyline with a cumulative arc-length table, so a spark can travel it at
 * constant speed with `pointAtLength`.
 */
export function catmullRomPolyline(points, samplesPerSegment = 24) {
  const polyline = [];
  if (points.length === 0) return { points: polyline, lengths: [], total: 0 };
  if (points.length === 1) return { points: [points[0]], lengths: [0], total: 0 };
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    for (let step = 0; step < samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      polyline.push({ x: blend(p0.x, p1.x, p2.x, p3.x), y: blend(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  polyline.push(points[points.length - 1]);
  const lengths = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    const dx = polyline[index].x - polyline[index - 1].x;
    const dy = polyline[index].y - polyline[index - 1].y;
    lengths.push(lengths[index - 1] + Math.hypot(dx, dy));
  }
  return { points: polyline, lengths, total: lengths[lengths.length - 1] };
}

export function pointAtLength(curve, length) {
  const { points, lengths, total } = curve;
  if (points.length === 0) return { x: 0, y: 0 };
  const target = clamp(length, 0, total);
  let low = 0;
  let high = lengths.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (lengths[middle] <= target) low = middle;
    else high = middle;
  }
  const span = lengths[high] - lengths[low] || 1;
  const amount = (target - lengths[low]) / span;
  return { x: lerp(points[low].x, points[high].x, amount), y: lerp(points[low].y, points[high].y, amount) };
}

/** Arc length along the curve at which it passes closest to `point`. */
export function lengthNearest(curve, point) {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  curve.points.forEach((candidate, index) => {
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = curve.lengths[index];
    }
  });
  return best;
}

export function polylinePath(points) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

/**
 * The stage background at `frame`: the scene's own colour, or during a change
 * (L-lead..L+out) the new colour revealed as a growing circle over the old one.
 * `from`/`to` are 'dark' | 'light' and `amount` 0..1 is the reveal. Never a mix
 * of the two: an OKLab crossfade passes through a flat mid-grey that reads as
 * a dropped frame when nothing else moves.
 */
export function backgroundAt(scenes, frame, lead, out) {
  let current = scenes[0].background;
  for (let index = 1; index < scenes.length; index += 1) {
    const boundary = scenes[index].startFrame;
    const next = scenes[index].background;
    if (frame < boundary - lead) break;
    if (frame < boundary + out && next !== current) {
      return { from: current, to: next, amount: easeInOut(progress(frame, boundary - lead, lead + out)) };
    }
    current = next;
  }
  return { from: current, to: current, amount: 1 };
}
