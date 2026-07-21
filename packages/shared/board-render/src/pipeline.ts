import sharp from 'sharp';
import { createOgBackgroundBuffer, getBackgroundRelPaths } from './background';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import type { OutputFormat, RenderableBoardDetails } from './types';

const THUMBNAIL_WEBP_OPTIONS: sharp.WebpOptions = {
  quality: 60,
  alphaQuality: 70,
  effort: 4,
};

const DEFAULT_WEBP_OPTIONS: sharp.WebpOptions = {
  quality: 80,
};

const DEFAULT_PNG_OPTIONS: sharp.PngOptions = {
  compressionLevel: 9,
  adaptiveFiltering: true,
};

const THUMBNAIL_JPEG_OPTIONS: sharp.JpegOptions = {
  quality: 85,
  chromaSubsampling: '4:4:4',
  progressive: false,
  optimiseScans: false,
};

const DEFAULT_JPEG_OPTIONS: sharp.JpegOptions = {
  quality: 90,
  chromaSubsampling: '4:4:4',
  mozjpeg: true,
};

/**
 * OG social-card JPEG encode: mozjpeg at quality 85 with full chroma so hold
 * rings stay crisp (~50–80KB at 1200×630).
 */
export const OG_JPEG_OPTIONS: sharp.JpegOptions = {
  quality: 85,
  chromaSubsampling: '4:4:4',
  mozjpeg: true,
};

function getJpegOptions(thumbnail: boolean): sharp.JpegOptions {
  return thumbnail ? THUMBNAIL_JPEG_OPTIONS : DEFAULT_JPEG_OPTIONS;
}

/** Resolve a public/-relative image path to an absolute filesystem path, or null if absent. */
export type ResolveImagePath = (relPath: string) => string | null;

export type RenderBoardImageParams = {
  /** Raw RGBA overlay pixels from the WASM renderer (already header-stripped). */
  overlayBuffer: Buffer;
  width: number;
  height: number;
  isOgVariant: boolean;
  format: OutputFormat;
  thumbnail: boolean;
  includeBackground: boolean;
  /** Scrim opacity (0–1) painted over the board photo before the overlay; 0 = none. */
  dimBackground: number;
  boardDetails: RenderableBoardDetails;
  resolveImagePath: ResolveImagePath;
};

export type RenderTimings = {
  sharpMs: number;
  composeMs: number;
  encodeMs: number;
  bgMs: number;
};

export type RenderBoardImageResult = {
  buffer: Buffer;
  contentType: string;
  timings: RenderTimings;
};

/**
 * Single-shot render used by the web `board-render` route: takes the WASM
 * overlay RGBA and produces the final encoded image, optionally compositing
 * background board photos and (for the OG variant) the social-card backdrop.
 */
export async function renderBoardImageBuffer({
  overlayBuffer,
  width,
  height,
  isOgVariant,
  format,
  thumbnail,
  includeBackground,
  dimBackground,
  boardDetails,
  resolveImagePath,
}: RenderBoardImageParams): Promise<RenderBoardImageResult> {
  const sharpT0 = performance.now();
  let imageBuffer: Buffer | null = null;
  let outputBuffer: Buffer | null = null;
  let outputContentType = 'image/png';
  let bgMs = 0;
  let composeMs = 0;
  let didCompositeBackground = false;

  if (includeBackground) {
    const bgT0 = performance.now();
    const bgRelPaths = getBackgroundRelPaths(boardDetails, thumbnail);
    const bgFsPaths = bgRelPaths
      .map((relPath) => resolveImagePath(relPath))
      .filter((path): path is string => path !== null);
    bgMs = performance.now() - bgT0;

    if (bgFsPaths.length > 0) {
      // Load and resize background images, skipping any that fail.
      const results = await Promise.allSettled(
        bgFsPaths.map((fsPath) => sharp(fsPath).resize(width, height, { fit: 'fill' }).toBuffer()),
      );
      const resizedBuffers = results
        .filter((result): result is PromiseFulfilledResult<Buffer> => result.status === 'fulfilled')
        .map((result) => result.value);

      const [firstBg, ...restBgs] = resizedBuffers;

      if (firstBg) {
        // Composite: first background as base → remaining backgrounds → optional
        // dim scrim → WASM overlay on top.
        const composeT0 = performance.now();
        const dimLayer =
          dimBackground > 0
            ? await sharp({
                create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: dimBackground } },
              })
                .png()
                .toBuffer()
            : null;
        const compositedImage = sharp(firstBg).composite([
          ...restBgs.map((buf) => ({ input: buf, blend: 'over' as const })),
          ...(dimLayer ? [{ input: dimLayer, blend: 'over' as const }] : []),
          {
            input: overlayBuffer,
            raw: { width, height, channels: 4 as const },
            blend: 'over' as const,
          },
        ]);
        if (!isOgVariant && format === 'webp') {
          outputBuffer = await compositedImage
            .webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : DEFAULT_WEBP_OPTIONS)
            .toBuffer();
          outputContentType = 'image/webp';
        } else if (!isOgVariant && format === 'jpeg') {
          outputBuffer = await compositedImage.jpeg(getJpegOptions(thumbnail)).toBuffer();
          outputContentType = 'image/jpeg';
        } else {
          imageBuffer = await compositedImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
        }
        composeMs = performance.now() - composeT0;
        didCompositeBackground = true;
      } else {
        // All background loads failed — fall back to overlay-only.
        const composeT0 = performance.now();
        const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
        if (!isOgVariant && format === 'webp') {
          outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
          outputContentType = 'image/webp';
        } else if (!isOgVariant && format === 'jpeg') {
          outputBuffer = await overlayImage.jpeg(getJpegOptions(thumbnail)).toBuffer();
          outputContentType = 'image/jpeg';
        } else {
          imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
        }
        composeMs = performance.now() - composeT0;
      }
    } else {
      // No background images found — fall back to overlay-only lossless.
      const composeT0 = performance.now();
      const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
      if (!isOgVariant && format === 'webp') {
        outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
        outputContentType = 'image/webp';
      } else if (!isOgVariant && format === 'jpeg') {
        outputBuffer = await overlayImage.jpeg(getJpegOptions(thumbnail)).toBuffer();
        outputContentType = 'image/jpeg';
      } else {
        imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
      }
      composeMs = performance.now() - composeT0;
    }
  } else {
    // Default: overlay-only lossless WebP (25-30% smaller than PNG).
    const composeT0 = performance.now();
    const overlayImage = sharp(overlayBuffer, { raw: { width, height, channels: 4 } });
    if (!isOgVariant && format === 'webp') {
      outputBuffer = await overlayImage.webp(thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true }).toBuffer();
      outputContentType = 'image/webp';
    } else if (!isOgVariant && format === 'jpeg') {
      outputBuffer = await overlayImage.jpeg(getJpegOptions(thumbnail)).toBuffer();
      outputContentType = 'image/jpeg';
    } else {
      imageBuffer = await overlayImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
    }
    composeMs = performance.now() - composeT0;
  }

  const encodeT0 = performance.now();

  if (outputBuffer === null && isOgVariant && imageBuffer) {
    const ogImage = sharp(createOgBackgroundBuffer(width, height)).composite([
      {
        input: imageBuffer,
        left: Math.round((OG_IMAGE_WIDTH - width) / 2),
        top: Math.round((OG_IMAGE_HEIGHT - height) / 2),
        blend: 'over',
      },
    ]);
    if (format === 'jpeg') {
      outputBuffer = await ogImage.jpeg(getJpegOptions(thumbnail)).toBuffer();
      outputContentType = 'image/jpeg';
    } else {
      outputBuffer = await ogImage.png(DEFAULT_PNG_OPTIONS).toBuffer();
      outputContentType = 'image/png';
    }
  } else if (outputBuffer === null && imageBuffer && format === 'webp') {
    const getWebpOptions = () => {
      if (thumbnail) return THUMBNAIL_WEBP_OPTIONS;
      if (didCompositeBackground) return DEFAULT_WEBP_OPTIONS;
      return { lossless: true };
    };
    outputBuffer = await sharp(imageBuffer).webp(getWebpOptions()).toBuffer();
    outputContentType = 'image/webp';
  } else if (outputBuffer === null && imageBuffer && format === 'jpeg') {
    outputBuffer = await sharp(imageBuffer).jpeg(getJpegOptions(thumbnail)).toBuffer();
    outputContentType = 'image/jpeg';
  } else if (outputBuffer === null && imageBuffer) {
    outputBuffer = imageBuffer;
    outputContentType = 'image/png';
  }

  if (!outputBuffer) {
    throw new Error('no output buffer generated');
  }

  const encodeMs = performance.now() - encodeT0;
  const sharpMs = performance.now() - sharpT0;

  return {
    buffer: outputBuffer,
    contentType: outputContentType,
    timings: { sharpMs, composeMs, encodeMs, bgMs },
  };
}

export type OgBaseResult = {
  /** Raw RGBA pixels of the composited backdrop + board photos, `OG_IMAGE_WIDTH`×`OG_IMAGE_HEIGHT`. */
  base: Buffer;
  /** X offset where the board photo (and later the overlay) sits on the canvas. */
  left: number;
  /** Y offset where the board photo (and later the overlay) sits on the canvas. */
  top: number;
};

/**
 * Compose the OG social-card base for a board config: the gradient backdrop
 * with the board photos composited (no climb overlay). The result is a raw
 * RGBA buffer the backend caches per board config — every climb on the same
 * board reuses it, so only the cheap overlay composite + encode runs per climb.
 */
export async function composeOgBaseBuffer(params: {
  boardDetails: RenderableBoardDetails;
  boardWidth: number;
  boardHeight: number;
  resolveImagePath: ResolveImagePath;
}): Promise<OgBaseResult> {
  const { boardDetails, boardWidth, boardHeight, resolveImagePath } = params;
  const left = Math.round((OG_IMAGE_WIDTH - boardWidth) / 2);
  const top = Math.round((OG_IMAGE_HEIGHT - boardHeight) / 2);

  const bgRelPaths = getBackgroundRelPaths(boardDetails, false);
  const bgFsPaths = bgRelPaths
    .map((relPath) => resolveImagePath(relPath))
    .filter((path): path is string => path !== null);

  const results = await Promise.allSettled(
    bgFsPaths.map((fsPath) => sharp(fsPath).resize(boardWidth, boardHeight, { fit: 'fill' }).toBuffer()),
  );
  const resizedBoardPhotos = results
    .filter((result): result is PromiseFulfilledResult<Buffer> => result.status === 'fulfilled')
    .map((result) => result.value);

  const backdrop = sharp(createOgBackgroundBuffer(boardWidth, boardHeight)).composite(
    resizedBoardPhotos.map((buf) => ({ input: buf, left, top, blend: 'over' as const })),
  );

  const base = await backdrop.raw().toBuffer();
  return { base, left, top };
}

/**
 * Composite the climb overlay onto a cached OG base and encode. JPEG is the OG
 * default (mozjpeg, quality 85); PNG and WebP are honoured when requested.
 */
export async function encodeOgImage(params: {
  base: Buffer;
  overlay: { buffer: Buffer; width: number; height: number; left: number; top: number };
  format: OutputFormat;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const { base, overlay, format } = params;
  const composited = sharp(base, {
    raw: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, channels: 4 },
  }).composite([
    {
      input: overlay.buffer,
      raw: { width: overlay.width, height: overlay.height, channels: 4 as const },
      left: overlay.left,
      top: overlay.top,
      blend: 'over',
    },
  ]);

  if (format === 'png') {
    return { buffer: await composited.png(DEFAULT_PNG_OPTIONS).toBuffer(), contentType: 'image/png' };
  }
  if (format === 'webp') {
    return { buffer: await composited.webp(DEFAULT_WEBP_OPTIONS).toBuffer(), contentType: 'image/webp' };
  }
  return { buffer: await composited.jpeg(OG_JPEG_OPTIONS).toBuffer(), contentType: 'image/jpeg' };
}
