import { resolve } from 'node:path';
import sharp from 'sharp';

/** Same first frame as the film, encoded once instead of by Next on each origin. */
export async function buildMarketingImageVariants(repoRoot: string): Promise<{ path: string; contents: Buffer }[]> {
  const sourcePath = resolve(repoRoot, 'packages/web/public/images/home/showcase-hero-9x16.webp');
  return Promise.all(
    [360, 540, 640, 720].map(async (width) => ({
      path: resolve(repoRoot, `packages/web/public/images/home/showcase-hero-9x16-${width}w.webp`),
      contents: await sharp(sourcePath).resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer(),
    })),
  );
}
