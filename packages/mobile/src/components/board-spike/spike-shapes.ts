/**
 * Selector-outline path generators for the rendering spike (issue #2202).
 *
 * The point of these is redundancy: a wavy ring and a spiky ring stay
 * distinguishable when the colour does not survive the board photo behind it
 * (or the viewer's colour vision), so the outline carries the hold's role even
 * when the hue is lost.
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
