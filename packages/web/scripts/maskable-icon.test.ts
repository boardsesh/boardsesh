import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  ICON_GROUND_RGB,
  MASKABLE_ICON_SIZE,
  MASKABLE_SAFE_ZONE_RATIO,
  measureOpaqueContentRadiusRatio,
} from './maskable-icon-geometry';

const webRoot = resolve(import.meta.dirname, '..');
const maskableIcon = resolve(webRoot, 'public/icons/icon-maskable-512.png');
const plainIcon = resolve(webRoot, 'public/icons/icon-512.png');

/**
 * A launcher crops a maskable icon to whatever shape the platform wants, so only
 * a centred circle of radius 0.40·W survives. The Boardsesh mark is an X whose
 * arms reach 0.4954·W, and for a while the maskable file was byte-identical to
 * `icon-512.png` — every panel tip clipped on Android, with nothing to catch it.
 *
 * Regenerate with `vp exec tsx packages/web/scripts/generate-maskable-icon.ts`.
 */
describe('maskable app icon', () => {
  it('keeps the mark inside the maskable safe zone', async () => {
    const radiusRatio = await measureOpaqueContentRadiusRatio(maskableIcon, { ground: ICON_GROUND_RGB });

    expect(
      radiusRatio,
      `icon-maskable-512.png draws artwork out to ${radiusRatio.toFixed(4)}·W, past the ` +
        `${MASKABLE_SAFE_ZONE_RATIO}·W a launcher guarantees. Regenerate it with ` +
        'packages/web/scripts/generate-maskable-icon.ts rather than shipping clipped panel tips.',
    ).toBeLessThanOrEqual(MASKABLE_SAFE_ZONE_RATIO);
  });

  it('is not just a copy of the plain icon', async () => {
    const maskableRadius = await measureOpaqueContentRadiusRatio(maskableIcon, { ground: ICON_GROUND_RGB });
    const plainRadius = await measureOpaqueContentRadiusRatio(plainIcon, { ground: ICON_GROUND_RGB });

    expect(maskableRadius).toBeLessThan(plainRadius);
  });

  it('is the size the manifest declares', async () => {
    const sharp = (await import('sharp')).default;
    const { width, height, hasAlpha } = await sharp(maskableIcon).metadata();

    expect({ width, height }).toEqual({ width: MASKABLE_ICON_SIZE, height: MASKABLE_ICON_SIZE });
    // A maskable icon is composited onto the launcher's ground, so it must be opaque.
    expect(hasAlpha).toBe(false);
  });
});
