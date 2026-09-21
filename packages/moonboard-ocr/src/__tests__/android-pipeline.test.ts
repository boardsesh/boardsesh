import { describe, expect, it, vi } from 'vite-plus/test';
import sharp from 'sharp';
import { SharpImageProcessor } from '../image-processor/sharp-processor';
import { parseWithProcessor } from '../parser-core';

vi.mock('../core/ocr', () => ({
  runOCR: vi.fn().mockResolvedValue({
    name: 'Synthetic pipeline',
    setter: 'Synthetic setter',
    angle: 40,
    userGrade: '7A/V6',
    setterGrade: 'Unknown',
    isBenchmark: false,
    warnings: ['Could not extract setter grade'],
  }),
}));

// Fixed full-screenshot coordinates exercise actual Sharp extraction, profile
// selection and hold mapping. OCR is mocked: this is wiring, not accuracy evidence.
describe('calibrated full-size Android screenshot pipeline', () => {
  it.each([
    { holdsetup: 21 as const, finishY: 676, handY: 1297, startY: 1840, finish: 'B17', hand: 'F9' },
    { holdsetup: 19 as const, finishY: 902, handY: 1290, startY: 1601, finish: 'B11', hand: 'F6' },
    { holdsetup: 22 as const, finishY: 902, handY: 1290, startY: 1601, finish: 'B11', hand: 'F6' },
  ])('maps all roles through the actual parser for setup $holdsetup', async (fixture) => {
    const width = 1008;
    const height = 2244;
    const pixels = Buffer.alloc(width * height * 4, 255);
    const rings = [
      { x: 223, y: fixture.finishY, color: [255, 0, 0] },
      { x: 534, y: fixture.handY, color: [0, 102, 255] },
      { x: 766, y: fixture.startY, color: [0, 255, 0] },
    ];
    for (const ring of rings) {
      for (let y = ring.y - 28; y <= ring.y + 28; y++) {
        for (let x = ring.x - 28; x <= ring.x + 28; x++) {
          const radius = Math.hypot(x - ring.x, y - ring.y);
          if (radius >= 22 && radius <= 28) pixels.set(ring.color, (y * width + x) * 4);
        }
      }
    }
    const image = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const processor = new SharpImageProcessor();
    await processor.load(image);
    const result = await parseWithProcessor(processor, {
      holdsetup: fixture.holdsetup,
      screenshotProfile: 'android-pixel8pro-1.3.68',
    });
    expect(result.success, result.error).toBe(true);
    expect(result.climb?.holds).toEqual({ start: ['I2'], hand: [fixture.hand], finish: [fixture.finish] });
    expect(result.climb?.userGrade).toBe('7A/V6');
    expect(result.climb?.setterGrade).toBe('Unknown');
    expect(result.warnings).toContain('Could not extract setter grade');
  });
});
