import { SPIKE_HOLD_ART_LIGHTNESS } from '../src/components/board-spike/spike-hold-lightness';

const srgbToLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
function oklabL(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

const fieldL = oklabL('#181225');
console.log('play field #181225 OkLab L =', fieldL.toFixed(3), '\n');
console.log('board'.padEnd(24), 'meanL', ' mean|ΔL|', ' % holds within 0.18 of the field');
for (const [board, table] of Object.entries(SPIKE_HOLD_ART_LIGHTNESS)) {
  const values = Object.values(table).filter((v) => v > 0); // 0 = no art under the ring at all
  const deltas = values.map((v) => Math.abs(v - fieldL));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const lowContrast = deltas.filter((d) => d < 0.18).length;
  console.log(
    board.padEnd(24),
    mean.toFixed(3).padStart(5),
    meanDelta.toFixed(3).padStart(8),
    `${((100 * lowContrast) / deltas.length).toFixed(1)}%`.padStart(8),
    `(${lowContrast}/${deltas.length})`,
  );
}
