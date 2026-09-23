/**
 * Regenerate `public/icons/icon-maskable-512.png` from the brand master.
 *
 * A maskable icon is cropped by the launcher to whatever shape the platform
 * wants — circle, squircle, rounded square — so only a centred circle of radius
 * 0.40·W is guaranteed to survive. The Boardsesh mark is an X whose four arms
 * reach 0.4954·W from centre, so shipping the plain mark as the maskable icon
 * clips all four panel tips on Android. Until this script ran, the maskable file
 * was byte-identical to `icon-512.png`, i.e. not maskable at all.
 *
 * The inset is derived from the master's own alpha channel rather than hardcoded,
 * so new artwork re-fits itself. `maskable-icon.test.ts` is the guard.
 *
 *   vp exec tsx packages/web/scripts/generate-maskable-icon.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import {
  ICON_GROUND_RGB,
  MASKABLE_ICON_SIZE,
  MASKABLE_RENDER_MARGIN,
  MASKABLE_SAFE_ZONE_RATIO,
  measureContentRadiusRatio,
} from './maskable-icon-geometry';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const masterPath = resolve(webRoot, 'public/brand/boardsesh-mark.png');
const outputPath = resolve(webRoot, 'public/icons/icon-maskable-512.png');

async function main(): Promise<void> {
  const radiusRatio = await measureContentRadiusRatio(masterPath);
  // Even, so centring on an even canvas is exact rather than rounded.
  const markSize =
    2 * Math.floor((MASKABLE_RENDER_MARGIN * MASKABLE_SAFE_ZONE_RATIO * MASKABLE_ICON_SIZE) / radiusRatio / 2);
  const offset = (MASKABLE_ICON_SIZE - markSize) / 2;

  const mark = await sharp(masterPath).resize(markSize, markSize, { fit: 'contain' }).png().toBuffer();
  await sharp({
    create: {
      width: MASKABLE_ICON_SIZE,
      height: MASKABLE_ICON_SIZE,
      channels: 4,
      background: { r: ICON_GROUND_RGB[0], g: ICON_GROUND_RGB[1], b: ICON_GROUND_RGB[2], alpha: 1 },
    },
  })
    .composite([{ input: mark, left: offset, top: offset }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(outputPath);

  console.log(
    `[maskable-icon] master content radius ${radiusRatio.toFixed(4)}·W → mark drawn at ${markSize}px ` +
      `inside ${MASKABLE_ICON_SIZE}px, safe-zone budget ${MASKABLE_SAFE_ZONE_RATIO}·W`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Maskable icon generation failed');
  process.exitCode = 1;
});
