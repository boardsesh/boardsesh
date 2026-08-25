import path from 'node:path';
import sharp from 'sharp';
import { getBoardRenderData } from '../src/lib/board-details';
import { SPIKE_BOARDS } from '../src/components/board-spike/spike-boards';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const IMAGES = path.join(ROOT, 'packages/web/public/images');

const srgbToLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luma = (r: number, g: number, b: number) => 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

async function main() {
for (const board of SPIKE_BOARDS) {
  const data = getBoardRenderData({ boardName: board.boardName, layoutId: board.layoutId, sizeId: board.sizeId, setIds: [...board.setIds] });
  if (!data) continue;
  const { boardWidth: w, boardHeight: h, holdsData, backgroundImageKeys } = data;
  const raw = { width: w, height: h, channels: 4 as const };
  let composite: Buffer | null = null;
  for (const key of backgroundImageKeys) {
    const layer = await sharp(path.join(IMAGES, key)).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    composite = composite === null ? layer : await sharp(composite, { raw }).composite([{ input: layer, raw, blend: 'over' }]).raw().toBuffer();
  }
  if (!composite) continue;

  let leds: Record<number, number> = {};
  try { leds = getLedPlacements(board.boardName, board.layoutId, board.sizeId); } catch { leds = {}; }
  const withLed = holdsData.filter((hold) => leds[hold.id] !== undefined).length;

  // Brightness in a 3px disc at the placement centre vs the hold's own mid-ring
  let brightCentres = 0;
  let sampled = 0;
  const ratios: number[] = [];
  for (const hold of holdsData) {
    const sample = (radius: number, inner = 0) => {
      let sum = 0, n = 0;
      const bound = Math.ceil(radius);
      for (let dy = -bound; dy <= bound; dy += 1) for (let dx = -bound; dx <= bound; dx += 1) {
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius || d2 < inner * inner) continue;
        const x = Math.round(hold.cx + dx), y = Math.round(hold.cy + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        if (composite![o + 3] < 128) continue;
        sum += luma(composite![o], composite![o + 1], composite![o + 2]); n += 1;
      }
      return n === 0 ? null : sum / n;
    };
    const centre = sample(3);
    const ring = sample(hold.r * 0.55, hold.r * 0.3);
    if (centre === null || ring === null) continue;
    sampled += 1;
    const ratio = centre / Math.max(1e-4, ring);
    ratios.push(ratio);
    if (ratio > 2.5) brightCentres += 1;
  }
  ratios.sort((a, b) => a - b);
  console.log(
    board.key.padEnd(24),
    `holds ${String(holdsData.length).padStart(3)}`,
    `withLED ${String(withLed).padStart(3)}`,
    `sampled ${String(sampled).padStart(3)}`,
    `brightCentre ${String(brightCentres).padStart(3)}`,
    `medianRatio ${(ratios[Math.floor(ratios.length / 2)] ?? 0).toFixed(2)}`,
  );
}
}
void main();
