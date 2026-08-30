import sharp from 'sharp';
import {
  createOgBackgroundBuffer,
  getBackgroundRelPaths,
  resolveArtPath,
  type BoardArtColorScheme,
} from './background';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import type { BoundedLru } from './lru';
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

/**
 * Process-lifetime caches a caller can hand in so repeat renders of the same
 * board skip re-decoding its photos. Both hold raw RGBA planes keyed by board
 * config, which is what the board photo composite costs — the per-climb overlay
 * is never cached here (the caller's byte cache covers that).
 */
export type RenderBoardImageCaches = {
  /** Folded board photos (raw RGBA, dim already baked in) for the plain render path. */
  boardBase?: BoundedLru<Buffer>;
  /** Gradient backdrop + board photos (raw RGBA) for the OG social-card path. */
  ogBase?: BoundedLru<OgBaseResult>;
  /** Coalesces identical OG base compositions, analogous to `boardBaseInFlight`. */
  ogBaseInFlight?: Map<string, Promise<OgBaseResult>>;
  /**
   * Composes of `boardBase` entries currently running, so two climbs on the
   * same board arriving together fold that board's photos once instead of
   * twice (~10 MB of planes for the tallest Kilter board). Owned by the caller
   * because the key describes the board and output size, not the caller's
   * `resolveImagePath` — sharing one across resolvers would serve the wrong
   * images. Omit it and each render composes its own base.
   */
  boardBaseInFlight?: Map<string, Promise<Buffer | null>>;
};

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
  /**
   * Which board art to composite. Defaults to light, so every existing caller renders the
   * same bytes it always did. Dark only differs for boards that ship a `.dark.webp` sibling.
   */
  colorScheme?: BoardArtColorScheme;
  /** Optional background caches. Omitted = every render composes its own base. */
  caches?: RenderBoardImageCaches;
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
  /**
   * Whether the board-photo base came from the caller's cache. `none` means no
   * cache was in play (no caller cache, or a path that doesn't use one).
   */
  cache?: 'hit' | 'miss' | 'none';
};

type EncodedImage = {
  /** Set when the final bytes are already encoded. */
  outputBuffer: Buffer | null;
  /** Set for the PNG intermediate the OG canvas composite consumes. */
  imageBuffer: Buffer | null;
  contentType: string;
};

/**
 * Encode a prepared sharp pipeline in the requested format. The OG variant
 * always lands on a PNG intermediate — its final encode happens after the
 * social canvas composite.
 */
async function encodeRendered(
  image: sharp.Sharp,
  options: { isOgVariant: boolean; format: OutputFormat; thumbnail: boolean; webpOptions: sharp.WebpOptions },
): Promise<EncodedImage> {
  const { isOgVariant, format, thumbnail, webpOptions } = options;
  if (!isOgVariant && format === 'webp') {
    return { outputBuffer: await image.webp(webpOptions).toBuffer(), imageBuffer: null, contentType: 'image/webp' };
  }
  if (!isOgVariant && format === 'jpeg') {
    return {
      outputBuffer: await image.jpeg(getJpegOptions(thumbnail)).toBuffer(),
      imageBuffer: null,
      contentType: 'image/jpeg',
    };
  }
  return { outputBuffer: null, imageBuffer: await image.png(DEFAULT_PNG_OPTIONS).toBuffer(), contentType: 'image/png' };
}

/**
 * Compose the board's background photos into a single raw RGBA plane at the
 * requested output size, with the dim scrim already baked in.
 *
 * Layers are decoded one at a time and folded into the accumulator as raw
 * pixels: no layer is ever re-encoded, and peak memory stays at roughly three
 * raw planes no matter how many hold-set images a board has. A layer that fails
 * to decode is skipped (the board still renders with whatever did load).
 *
 * Dimming stays a composited black scrim, deliberately. Scaling RGB by
 * `1 - dim` looks equivalent and allocates nothing, but only for *opaque*
 * pixels: QA measured every board WebP and they all carry alpha — the board
 * photos are transparent everywhere except the holds, so ~77% of pixels would
 * come out with different alpha and up to 127 of RGB delta. `dim_background` is
 * supposed to be a full-bleed wash over the whole image, which is what the iOS
 * Live Activity widget asks for with `dim_background=0.18` and what mobile's
 * LayeredClimbImage draws as a full-bleed `rgba(0, 0, 0, 0.18)` view. The scrim
 * is composited over the *folded* base and baked into it, so a board pays for
 * it once on a cold cache rather than once per request as before.
 *
 * Returns null when no background image resolves — the caller then falls back
 * to an overlay-only render.
 */
export async function composeBoardBaseBuffer(params: {
  boardDetails: RenderableBoardDetails;
  width: number;
  height: number;
  thumbnail: boolean;
  dimBackground: number;
  resolveImagePath: ResolveImagePath;
  colorScheme?: BoardArtColorScheme;
}): Promise<Buffer | null> {
  const { boardDetails, width, height, thumbnail, dimBackground, resolveImagePath, colorScheme } = params;
  const rawLayer = { width, height, channels: 4 as const };

  const bgFsPaths = getBackgroundRelPaths(boardDetails, thumbnail, colorScheme)
    .map((relPath) => resolveArtPath(relPath, resolveImagePath))
    .filter((fsPath): fsPath is string => fsPath !== null);
  if (bgFsPaths.length === 0) return null;

  let base: Buffer | null = null;
  for (const fsPath of bgFsPaths) {
    try {
      const layer = await sharp(fsPath).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
      if (base === null) {
        base = layer;
        continue;
      }
      base = await sharp(base, { raw: rawLayer })
        .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
        .raw()
        .toBuffer();
    } catch {
      // A single unreadable board photo must not fail the whole render.
    }
  }

  if (base === null) return null;
  if (dimBackground <= 0) return base;

  // Composited straight from a `create` descriptor: same pixels the old
  // per-request PNG scrim produced, without encoding and decoding it first.
  return sharp(base, { raw: rawLayer })
    .composite([
      {
        input: { create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: dimBackground } } },
        blend: 'over',
      },
    ])
    .raw()
    .toBuffer();
}

/**
 * Single-shot render used by the backend board-render service: takes the WASM
 * overlay RGBA and produces the final encoded image, optionally compositing
 * background board photos and (for the OG variant) the social-card backdrop.
 *
 * Pass `caches` to reuse the board-photo base across requests. Without it every
 * call re-decodes the board photos, which at ~50k renders/day is the bulk of
 * both the CPU and the peak memory.
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
  colorScheme,
  caches,
}: RenderBoardImageParams): Promise<RenderBoardImageResult> {
  const sharpT0 = performance.now();
  const rawPlane = { width, height, channels: 4 as const };
  let imageBuffer: Buffer | null = null;
  let outputBuffer: Buffer | null = null;
  let outputContentType = 'image/png';
  let bgMs = 0;
  let composeMs = 0;
  let cache: RenderBoardImageResult['cache'] = 'none';

  const overlayOnlyImage = () => sharp(overlayBuffer, { raw: rawPlane });
  const overlayWebpOptions: sharp.WebpOptions = thumbnail ? THUMBNAIL_WEBP_OPTIONS : { lossless: true };
  const bgRelPaths = includeBackground ? getBackgroundRelPaths(boardDetails, thumbnail, colorScheme) : [];

  if (includeBackground && isOgVariant && dimBackground === 0) {
    // OG social card: backdrop + board photos are identical for every climb on
    // the board, so the composed base is cached and only the overlay composite
    // + encode runs per climb.
    const bgT0 = performance.now();
    // The OG base always composes full-size photos, so key it on those paths —
    // not on `bgRelPaths`, which honours `thumbnail`.
    const ogKey = `${getBackgroundRelPaths(boardDetails, false, colorScheme).join('|')}:${width}x${height}:og`;
    let ogBase = caches?.ogBase?.get(ogKey);
    let reusedInFlightBase = false;
    if (ogBase) {
      cache = 'hit';
    } else {
      const composeParams = { boardDetails, boardWidth: width, boardHeight: height, resolveImagePath, colorScheme };
      const inFlightBases = caches?.ogBaseInFlight;
      if (inFlightBases) {
        const alreadyComposing = inFlightBases.get(ogKey);
        reusedInFlightBase = alreadyComposing !== undefined;
        const composePromise =
          alreadyComposing ??
          composeOgBaseBuffer(composeParams).finally(() => {
            inFlightBases.delete(ogKey);
          });
        if (!alreadyComposing) inFlightBases.set(ogKey, composePromise);
        ogBase = await composePromise;
      } else {
        ogBase = await composeOgBaseBuffer(composeParams);
      }
      caches?.ogBase?.set(ogKey, ogBase);
      cache = caches?.ogBase ? (reusedInFlightBase ? 'hit' : 'miss') : 'none';
    }
    bgMs = performance.now() - bgT0;

    const composeT0 = performance.now();
    const encoded = await encodeOgImage({
      base: ogBase.base,
      overlay: { buffer: overlayBuffer, width, height, left: ogBase.left, top: ogBase.top },
      format,
    });
    outputBuffer = encoded.buffer;
    outputContentType = encoded.contentType;
    composeMs = performance.now() - composeT0;
  } else if (includeBackground && isOgVariant) {
    // Dimmed OG card: no caller asks for this today, so it keeps the original
    // uncached composite rather than growing a third cache key.
    const bgT0 = performance.now();
    const bgFsPaths = bgRelPaths
      .map((relPath) => resolveArtPath(relPath, resolveImagePath))
      .filter((fsPath): fsPath is string => fsPath !== null);
    bgMs = performance.now() - bgT0;

    const composeT0 = performance.now();
    const results = await Promise.allSettled(
      bgFsPaths.map((fsPath) => sharp(fsPath).resize(width, height, { fit: 'fill' }).toBuffer()),
    );
    const [firstBg, ...restBgs] = results
      .filter((result): result is PromiseFulfilledResult<Buffer> => result.status === 'fulfilled')
      .map((result) => result.value);

    if (firstBg) {
      imageBuffer = await sharp(firstBg)
        .composite([
          ...restBgs.map((buf) => ({ input: buf, blend: 'over' as const })),
          {
            // Same `create` descriptor the cached path uses — no PNG round-trip.
            input: { create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: dimBackground } } },
            blend: 'over' as const,
          },
          { input: overlayBuffer, raw: rawPlane, blend: 'over' as const },
        ])
        .png(DEFAULT_PNG_OPTIONS)
        .toBuffer();
    } else {
      imageBuffer = await overlayOnlyImage().png(DEFAULT_PNG_OPTIONS).toBuffer();
    }
    composeMs = performance.now() - composeT0;
  } else if (includeBackground) {
    // Board photos folded to one raw RGBA plane (dim baked in), cached per board
    // config + size. The per-climb work is then a single decode-free composite.
    const bgT0 = performance.now();
    const baseKey = `${bgRelPaths.join('|')}:${width}x${height}:d${dimBackground}`;
    let base = caches?.boardBase?.get(baseKey);
    if (base) {
      cache = 'hit';
    } else {
      const composeParams = { boardDetails, width, height, thumbnail, dimBackground, resolveImagePath, colorScheme };
      const inFlightBases = caches?.boardBaseInFlight;
      let composed: Buffer | null;
      if (inFlightBases) {
        const alreadyComposing = inFlightBases.get(baseKey);
        const composePromise =
          alreadyComposing ??
          composeBoardBaseBuffer(composeParams).finally(() => {
            inFlightBases.delete(baseKey);
          });
        if (!alreadyComposing) inFlightBases.set(baseKey, composePromise);
        composed = await composePromise;
      } else {
        composed = await composeBoardBaseBuffer(composeParams);
      }
      base = composed ?? undefined;
      if (base) caches?.boardBase?.set(baseKey, base);
      cache = caches?.boardBase ? 'miss' : 'none';
    }
    bgMs = performance.now() - bgT0;

    const composeT0 = performance.now();
    if (base) {
      const composited = sharp(base, { raw: rawPlane }).composite([
        { input: overlayBuffer, raw: rawPlane, blend: 'over' as const },
      ]);
      const encoded = await encodeRendered(composited, {
        isOgVariant,
        format,
        thumbnail,
        webpOptions: thumbnail ? THUMBNAIL_WEBP_OPTIONS : DEFAULT_WEBP_OPTIONS,
      });
      outputBuffer = encoded.outputBuffer;
      imageBuffer = encoded.imageBuffer;
      outputContentType = encoded.contentType;
    } else {
      // No background image resolved — fall back to overlay-only lossless.
      const encoded = await encodeRendered(overlayOnlyImage(), {
        isOgVariant,
        format,
        thumbnail,
        webpOptions: overlayWebpOptions,
      });
      outputBuffer = encoded.outputBuffer;
      imageBuffer = encoded.imageBuffer;
      outputContentType = encoded.contentType;
    }
    composeMs = performance.now() - composeT0;
  } else {
    // Default: overlay-only lossless WebP (25-30% smaller than PNG).
    const composeT0 = performance.now();
    const encoded = await encodeRendered(overlayOnlyImage(), {
      isOgVariant,
      format,
      thumbnail,
      webpOptions: overlayWebpOptions,
    });
    outputBuffer = encoded.outputBuffer;
    imageBuffer = encoded.imageBuffer;
    outputContentType = encoded.contentType;
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
  } else if (outputBuffer === null && imageBuffer) {
    // Only PNG lands here: every branch above hands back finished bytes for
    // WebP and JPEG, and the OG variant is taken by the branch above this one.
    // There is nothing left to re-encode.
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
    cache,
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
  colorScheme?: BoardArtColorScheme;
}): Promise<OgBaseResult> {
  const { boardDetails, boardWidth, boardHeight, resolveImagePath, colorScheme } = params;
  const left = Math.round((OG_IMAGE_WIDTH - boardWidth) / 2);
  const top = Math.round((OG_IMAGE_HEIGHT - boardHeight) / 2);

  const bgRelPaths = getBackgroundRelPaths(boardDetails, false, colorScheme);
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
