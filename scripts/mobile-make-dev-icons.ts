/// <reference types="node" />

/**
 * Generates the reddish "Boardsesh Dev" launcher/splash icons from the
 * production brand PNGs by rotating their hue out of purple and into the
 * red/orange range. The dev-client APK (.github/workflows/android-apk-dev-client.yml)
 * uses these via app.config.ts when BOARDSESH_APP_VARIANT=dev so the dev build
 * is obviously distinct on the home screen.
 *
 * Output lives in packages/mobile/dev-assets/ — a sibling of assets/ on purpose:
 * `assetBundlePatterns: ['assets/**']` would otherwise pull these into every
 * production OTA bundle. The icons are still compiled into the APK's native res/
 * from the explicit path in app.config.ts.
 *
 * Re-run this whenever the brand mark changes: `vp run mobile:make-dev-icons`.
 * The three PNGs are committed so local dev-variant prebuilds work without a
 * generation step.
 */

import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = resolve(ROOT_DIR, 'packages', 'mobile', 'assets');
const DEV_ASSETS_DIR = resolve(ROOT_DIR, 'packages', 'mobile', 'dev-assets');
const ICON_FILES = ['icon.png', 'adaptive-icon.png', 'splash-icon.png'] as const;

// Hue rotation (degrees) pushes the brand purple (~280°) into red/orange; the
// saturation bump makes it read as a deliberate "dev" filter rather than a
// faded tint. Low-saturation pixels (the dark phone bezels) barely move, so the
// mark stays legible. modulate() preserves the alpha channel.
const HUE_ROTATION_DEGREES = 90;
const SATURATION_MULTIPLIER = 1.25;

async function main(): Promise<void> {
  await mkdir(DEV_ASSETS_DIR, { recursive: true });

  for (const fileName of ICON_FILES) {
    const sourcePath = resolve(ASSETS_DIR, fileName);
    const outputPath = resolve(DEV_ASSETS_DIR, fileName);
    await sharp(sourcePath)
      .modulate({ hue: HUE_ROTATION_DEGREES, saturation: SATURATION_MULTIPLIER })
      .toFile(outputPath);
    console.log(`[mobile:make-dev-icons] ${fileName} -> dev-assets/${fileName}`);
  }

  console.log('');
  console.log(`[mobile:make-dev-icons] Wrote ${ICON_FILES.length} reddish dev icons to packages/mobile/dev-assets/.`);
  console.log('[mobile:make-dev-icons] Commit them so local BOARDSESH_APP_VARIANT=dev prebuilds resolve the icons.');
}

main().catch((error: unknown) => {
  console.error('[mobile:make-dev-icons] Failed to generate dev icons.');
  console.error(error);
  process.exit(1);
});
