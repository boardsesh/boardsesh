import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildDarkKeyMask, buildWhiteKeyMask } from '@boardsesh/board-art-geometry/segmentation';

const ART_DIR = path.resolve(import.meta.dirname, '../../../../mobile/src/components/quantum/board-art');

describe('buildDarkKeyMask', () => {
  it('removes corner-connected ground and keeps a dark LED aperture inside a hold', () => {
    const pixels = new Uint8Array(20 * 20 * 3).fill(43);
    for (let y = 6; y <= 13; y += 1) {
      for (let x = 6; x <= 13; x += 1) {
        const offset = (y * 20 + x) * 3;
        pixels.fill(180, offset, offset + 3);
      }
    }
    pixels.fill(0, (9 * 20 + 9) * 3, (9 * 20 + 9) * 3 + 3);
    const snapshot = Uint8Array.from(pixels);
    const keyed = buildDarkKeyMask(pixels, 20, 20, 3);
    expect(keyed.mask[0]).toBe(0);
    expect(keyed.mask[9 * 20 + 9]).toBe(1);
    expect(keyed.mask[6 * 20 + 6]).toBe(0);
    expect(keyed.mask[7 * 20 + 7]).toBe(1);
    expect(keyed.maskShare).toBeCloseTo(36 / 400);
    expect(pixels).toEqual(snapshot);
  });

  const goldens = { xl: [0.6555, 0.3066], l: [0.6707, 0.2924], m: [0.6711, 0.2913] } as const;

  it.each(['xl', 'l', 'm'] as const)('keys %s lossless art across the ground threshold plateau', async (model) => {
    const { data: pixels, info } = await sharp(path.join(ART_DIR, `quantum-${model}.webp`))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const keyed = buildDarkKeyMask(pixels, info.width, info.height, info.channels);
    expect(keyed.groundShare).toBeCloseTo(goldens[model][0], 4);
    expect(keyed.maskShare).toBeCloseTo(goldens[model][1], 4);
    const shares = [50, 55, 60, 65, 70].map(
      (groundCeiling) => buildDarkKeyMask(pixels, info.width, info.height, info.channels, { groundCeiling }).maskShare,
    );
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.025);
    expect(shares[2]).toBeGreaterThan(0.05);
    expect(shares[2]).toBeLessThan(0.6);
  });
  it('keys S Fitness white ground inside its decorative frame', async () => {
    const { data: pixels, info } = await sharp(path.join(ART_DIR, 'quantum-s-fitness.webp'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const keyed = buildWhiteKeyMask(pixels, info.width, info.height, info.channels, {
      extraSeeds: [20 * info.width + 20],
    });
    expect(keyed.groundShare).toBeCloseTo(0.5571, 4);
    expect(keyed.maskShare).toBeCloseTo(0.4079, 4);
    const shares = [225, 230, 235, 240, 245].map(
      (groundFloor) =>
        buildWhiteKeyMask(pixels, info.width, info.height, info.channels, {
          groundFloor,
          extraSeeds: [20 * info.width + 20],
        }).maskShare,
    );
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.025);
    expect(shares[2]).toBeLessThan(0.6);
    expect(shares[2]).toBeGreaterThan(0.1);
  });
});
