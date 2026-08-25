/**
 * Outline and selector path generators for the rendering spike (issue #2202).
 *
 * The selector generators exist for redundancy: a wavy ring and a spiky ring
 * stay distinguishable when the colour does not survive the board photo behind
 * it (or the viewer's colour vision), so the outline carries the hold's role
 * even when the hue is lost.
 */

/** Circle sampled as a closed path, so every generator returns the same kind of `d`. */
export function plainRingPath(cx: number, cy: number, radius: number): string {
  return `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0 Z`;
}

function closedPolarPath(cx: number, cy: number, radiusAt: (angle: number) => number, samples: number): string {
  let path = '';
  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    const radius = radiusAt(angle);
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    path += index === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)} ` : `L ${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return `${path}Z`;
}

/**
 * Sinusoidal ring — `lobes` bumps around the circumference, amplitude as a
 * fraction of the radius. Reads as "a circle, but rippled" at a glance.
 */
export function wavyRingPath(cx: number, cy: number, radius: number, lobes = 12, amplitude = 0.1): string {
  return closedPolarPath(cx, cy, (angle) => radius * (1 + amplitude * Math.sin(lobes * angle)), lobes * 12);
}

/**
 * Star ring — `points` sharp spikes. Sampled at exactly the vertices so the
 * corners stay sharp instead of being rounded off by the polyline.
 */
export function spikyRingPath(cx: number, cy: number, radius: number, points = 10, amplitude = 0.22): string {
  const vertices = points * 2;
  let path = '';
  for (let index = 0; index < vertices; index += 1) {
    const angle = (index / vertices) * Math.PI * 2 - Math.PI / 2;
    const vertexRadius = radius * (index % 2 === 0 ? 1 + amplitude : 1 - amplitude);
    const x = cx + vertexRadius * Math.cos(angle);
    const y = cy + vertexRadius * Math.sin(angle);
    path += index === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)} ` : `L ${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return `${path}Z`;
}

/** Straight-line closed polygon through flat [x0, y0, x1, y1, …] points. */
export function polygonPath(points: readonly number[], cx: number, cy: number): string {
  let path = '';
  for (let index = 0; index < points.length; index += 2) {
    path += `${index === 0 ? 'M' : 'L'} ${cx + points[index]} ${cy + points[index + 1]} `;
  }
  return `${path}Z`;
}

/**
 * Closed centripetal Catmull-Rom spline through flat [x0, y0, x1, y1, …] points,
 * converted to cubic Béziers.
 *
 * The traced silhouettes are Douglas-Peucker output, so their vertices are the
 * corners of a polygon — legible, but visibly faceted on a big hold. Curving
 * through the same points costs nothing to store and only lengthens the path.
 *
 * Centripetal (alpha = 0.5) rather than uniform parameterisation, because the
 * points are unevenly spaced by construction: uniform Catmull-Rom bulges outward
 * wherever a long segment meets a short one, and on a hold outline that bulge is
 * a tint or a glow spilling past the edge of the hold it is supposed to be
 * tracing. Centripetal is the standard fix — it cannot cusp or self-intersect.
 */
export function splinePath(points: readonly number[], cx: number, cy: number): string {
  const count = points.length / 2;
  if (count < 3) return polygonPath(points, cx, cy);
  const at = (index: number): [number, number] => {
    const wrapped = ((index % count) + count) % count;
    return [cx + points[wrapped * 2], cy + points[wrapped * 2 + 1]];
  };
  /** Centripetal knot spacing: the square root of the chord length. */
  const knot = (from: [number, number], to: [number, number]): number =>
    Math.max(1e-4, Math.sqrt(Math.hypot(to[0] - from[0], to[1] - from[1])));

  const [startX, startY] = at(0);
  let path = `M ${startX.toFixed(1)} ${startY.toFixed(1)} `;
  for (let index = 0; index < count; index += 1) {
    const previous = at(index - 1);
    const current = at(index);
    const next = at(index + 1);
    const after = at(index + 2);

    const d1 = knot(previous, current);
    const d2 = knot(current, next);
    const d3 = knot(next, after);

    const control1: [number, number] = [0, 1].map((axis) => {
      const tangent =
        (current[axis] - previous[axis]) / d1 -
        (next[axis] - previous[axis]) / (d1 + d2) +
        (next[axis] - current[axis]) / d2;
      return current[axis] + (d2 * tangent) / 3;
    }) as [number, number];
    const control2: [number, number] = [0, 1].map((axis) => {
      const tangent =
        (next[axis] - current[axis]) / d2 - (after[axis] - current[axis]) / (d2 + d3) + (after[axis] - next[axis]) / d3;
      return next[axis] - (d2 * tangent) / 3;
    }) as [number, number];

    path +=
      `C ${control1[0].toFixed(1)} ${control1[1].toFixed(1)} ` +
      `${control2[0].toFixed(1)} ${control2[1].toFixed(1)} ` +
      `${next[0].toFixed(1)} ${next[1].toFixed(1)} `;
  }
  return `${path}Z`;
}
