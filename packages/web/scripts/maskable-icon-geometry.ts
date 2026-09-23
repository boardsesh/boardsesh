import sharp from 'sharp';

/** Every launcher crop is guaranteed to keep at least this centred circle. */
export const MASKABLE_SAFE_ZONE_RATIO = 0.4;

/** The size the manifest declares for the maskable entry. */
export const MASKABLE_ICON_SIZE = 512;

/**
 * Shrink the mark 1% below the raw safe-zone fit. Resampling the master leaves
 * antialiased pixels a fraction outside the shape's true edge, and centring an
 * integer-sized mark on an integer canvas can shift it half a pixel — without
 * the margin the measured radius lands at 0.4002·W and the guard test fails on
 * arithmetic rather than on artwork.
 */
export const MASKABLE_RENDER_MARGIN = 0.99;

/**
 * The ground every flattened icon is composited onto. Matches
 * `adaptiveIcon.backgroundColor` in `packages/mobile/app.config.ts` — web and
 * Android must not disagree about what shows around the mark after a crop.
 */
export const ICON_GROUND_RGB = [0, 0, 0] as const;

/** Alpha below this is background, not artwork — the master's edges are antialiased. */
const ALPHA_FLOOR = 16;

/**
 * Farthest opaque pixel from the image centre, as a fraction of the image width.
 *
 * Radius, not a bounding box: a maskable crop is a circle, so an X-shaped mark
 * that fits a square box comfortably can still have its diagonal tips cut off.
 */
export async function measureContentRadiusRatio(imagePath: string): Promise<number> {
  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const centreX = (info.width - 1) / 2;
  const centreY = (info.height - 1) / 2;
  let maxRadius = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] <= ALPHA_FLOOR) continue;
      const radius = Math.hypot(x - centreX, y - centreY);
      if (radius > maxRadius) maxRadius = radius;
    }
  }

  return maxRadius / info.width;
}

/**
 * Same measurement for an opaque icon: the farthest pixel that is not the ground
 * colour. Maskable icons ship flattened, so there is no alpha to read.
 *
 * Pass `ground` when the caller knows it. The default reads the top-left pixel,
 * which is correct for any icon with an inset mark but would silently measure
 * nothing if artwork ever reached the corner.
 */
export async function measureOpaqueContentRadiusRatio(
  imagePath: string,
  { ground, groundTolerance = 12 }: { ground?: readonly [number, number, number]; groundTolerance?: number } = {},
): Promise<number> {
  const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const centreX = (info.width - 1) / 2;
  const centreY = (info.height - 1) / 2;
  const groundPixel = ground ?? [data[0], data[1], data[2]];
  let maxRadius = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const pixel = (y * info.width + x) * info.channels;
      const distanceFromGround = Math.max(
        Math.abs(data[pixel] - groundPixel[0]),
        Math.abs(data[pixel + 1] - groundPixel[1]),
        Math.abs(data[pixel + 2] - groundPixel[2]),
      );
      if (distanceFromGround <= groundTolerance) continue;
      const radius = Math.hypot(x - centreX, y - centreY);
      if (radius > maxRadius) maxRadius = radius;
    }
  }

  return maxRadius / info.width;
}
