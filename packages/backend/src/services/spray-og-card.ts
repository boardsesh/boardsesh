import { and, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { BoundedLru, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, type OutputFormat } from '@boardsesh/board-render';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants';
import { IDENTITY_HOMOGRAPHY, invert, mapPoint, mapRadius, type Homography } from '@boardsesh/spray-wall-geometry';
import { sprayWallVersions, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { aliveHolds } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { getPublicUrl, isS3Configured } from '../storage/s3';
import { logger } from '../utils/logger';

/**
 * Open Graph share cards for spray-wall climbs (SW-16, issue #5449).
 *
 * Every other board's card is a pure function of the query string: the backdrop
 * ships in the repo and the hold positions come from generated constants. A wall
 * has neither. Its background is a photograph in object storage and its holds
 * live in `spray_wall_holds`, so this card is answered from the database — and
 * only for a wall whose owner has put it on the open web.
 *
 * It is deliberately NOT part of `board-render.ts`. That pipeline's image
 * resolver is synchronous and reads the local filesystem, which a photo fetched
 * over HTTP can never satisfy, and its WASM overlay draws a catalogue board's
 * fixed geometry. sharp plus an SVG overlay does the whole job here.
 */

/** The dark play field every other OG card composites over. */
const OG_FIELD_COLOR = '#181225';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FALLBACK_HOLD_COLOR = '#FFFFFF';

/** Hold marks are drawn at this share of the mark's radius, floored so a small hold still reads. */
const MARK_STROKE_RATIO = 0.16;
const MIN_MARK_STROKE = 2;
/** The dark outer stroke that keeps a light hold legible on a light wall. */
const HALO_EXTRA_STROKE = 2.5;
/** Low enough that the photograph stays readable under the mark. */
const MARK_FILL_OPACITY = 0.22;

const JPEG_OPTIONS: sharp.JpegOptions = { quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true };
const PNG_OPTIONS: sharp.PngOptions = { compressionLevel: 9, adaptiveFiltering: true };
const WEBP_OPTIONS: sharp.WebpOptions = { quality: 80 };

export type SprayOgWallRow = {
  wallId: number;
  layoutId: number;
  wallName: string;
  isPublic: boolean;
  publicPhotoKey: string | null;
  currentVersionId: number | null;
};

export type SprayOgVersionRow = {
  photoWidth: number | null;
  photoHeight: number | null;
  homography: number[] | null;
};

export type SprayOgHold = {
  holdId: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
};

export type SprayOgCardDeps = {
  loadWall: (layoutId: number) => Promise<SprayOgWallRow | null>;
  loadPublishedVersion: (wallId: number) => Promise<SprayOgVersionRow | null>;
  loadAliveHolds: (wallId: number) => Promise<SprayOgHold[]>;
  /** Fetches the public photo bytes. Called ONLY after the wall has cleared every visibility gate. */
  fetchPhotoBytes: (photoUrl: string) => Promise<Buffer>;
  publicPhotoUrl: (photoKey: string) => string | null;
};

export type SprayOgCardResult =
  | { kind: 'card'; buffer: Buffer; contentType: string; timings: { photoMs: number; composeMs: number } }
  | { kind: 'not-found' };

/**
 * Rendered cards, keyed on everything that can change the bytes.
 *
 * The version and the photo key are BOTH in the key, and neither is redundant.
 * A reset re-points the public copy under an unchanged `layout_id`, so the
 * version moves while the key may not; a demote-then-re-promote mints a fresh
 * 128-bit key (`sprayWallPublicPhotoKey`) under an unchanged published version,
 * so the key moves while the version does not. Either one alone would serve a
 * stale photograph.
 *
 * Small on purpose: this exists because Facebook, Twitter, WhatsApp and Slack
 * each fetch the same card independently over a network hop, not to be a
 * long-lived store.
 */
const cardCache = new BoundedLru<{ buffer: Buffer; contentType: string }>({
  maxEntries: 24,
  maxBytes: 16 * 1024 * 1024,
  sizeOf: (value) => value.buffer.length,
});

function cardCacheKey(params: {
  layoutId: number;
  currentVersionId: number;
  publicPhotoKey: string;
  frames: string;
  format: OutputFormat;
}): string {
  return [params.layoutId, params.currentVersionId, params.publicPhotoKey, params.format, params.frames].join('|');
}

/** Test seam: the cache is process-lifetime, so a test that renders twice needs this. */
export function resetSprayOgCardCache(): void {
  cardCache.clear();
}

function safeHoldColor(color: string | undefined): string {
  return color !== undefined && HEX_COLOR.test(color) ? color : FALLBACK_HOLD_COLOR;
}

/** Two decimals is well under a pixel at 1200 wide and keeps the SVG small. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type SprayOverlayMark = {
  holdId: number;
  color: string;
  /** Photo-pixel centre and radius, already scaled into the placed photo's rectangle. */
  centerX: number;
  centerY: number;
  radius: number;
  /** Flat `[x0, y0, x1, y1, …]` in the same placed-pixel frame, or null for a ring. */
  points: number[] | null;
};

/**
 * The lit holds of a climb, mapped out of canonical coordinates and onto the
 * placed photograph.
 *
 * `invert` is the canonical→photo direction (no image is ever warped, see
 * `docs/spray-walls.md`); `photoToPlaced` then scales that into whatever
 * rectangle the photo was resized into on the card.
 */
export function buildSprayOverlayMarks(params: {
  holds: readonly SprayOgHold[];
  frames: string;
  canonicalToPhoto: Homography;
  photoToPlaced: number;
}): SprayOverlayMark[] {
  const { holds, frames, canonicalToPhoto, photoToPlaced } = params;
  const litByHoldId = convertLitUpHoldsStringToMap(frames, 'spray')[0] ?? {};

  const marks: SprayOverlayMark[] = [];
  for (const hold of holds) {
    const lit = litByHoldId[hold.holdId];
    if (!lit) continue;

    const [photoX, photoY] = mapPoint(canonicalToPhoto, hold.cx, hold.cy);
    if (!Number.isFinite(photoX) || !Number.isFinite(photoY)) continue;
    const radius = hold.r * mapRadius(canonicalToPhoto, hold.cx, hold.cy) * photoToPlaced;
    if (!Number.isFinite(radius) || radius <= 0) continue;

    let points: number[] | null = null;
    if (hold.outline && hold.outline.length >= 6) {
      const mapped: number[] = [];
      let everyPointFinite = true;
      for (let index = 0; index + 1 < hold.outline.length; index += 2) {
        // An outline point is in units of the hold's own radius, relative to its
        // centre, so it becomes canonical-absolute before it can be mapped.
        const canonicalX = hold.cx + hold.outline[index] * hold.r;
        const canonicalY = hold.cy + hold.outline[index + 1] * hold.r;
        const [outlineX, outlineY] = mapPoint(canonicalToPhoto, canonicalX, canonicalY);
        if (!Number.isFinite(outlineX) || !Number.isFinite(outlineY)) {
          everyPointFinite = false;
          break;
        }
        mapped.push(outlineX * photoToPlaced, outlineY * photoToPlaced);
      }
      if (everyPointFinite) points = mapped;
    }

    marks.push({
      holdId: hold.holdId,
      color: safeHoldColor(lit.displayColor),
      centerX: photoX * photoToPlaced,
      centerY: photoY * photoToPlaced,
      radius,
      points,
    });
  }
  return marks;
}

/**
 * The overlay as plain SVG libvips can rasterise: no CSS, no filters.
 *
 * Each mark is drawn twice — a dark halo underneath, the role colour on top —
 * because a spray wall is a photograph of whatever the climber owns, and a
 * yellow hold on a plywood wall lit with a yellow ring is invisible otherwise.
 * A hold with a traced silhouette gets its real shape; one without falls back to
 * a ring at its placement radius, the same rule the rest of the render path uses.
 */
export function buildSprayOverlaySvg(params: {
  width: number;
  height: number;
  marks: readonly SprayOverlayMark[];
}): string {
  const { width, height, marks } = params;
  const shapes: string[] = [];

  for (const mark of marks) {
    const strokeWidth = Math.max(MIN_MARK_STROKE, mark.radius * MARK_STROKE_RATIO);
    const haloWidth = strokeWidth + HALO_EXTRA_STROKE;

    const geometry =
      mark.points === null
        ? `<circle cx="${round2(mark.centerX)}" cy="${round2(mark.centerY)}" r="${round2(mark.radius)}"`
        : `<polygon points="${formatPolygonPoints(mark.points)}"`;

    shapes.push(
      `${geometry} fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="${round2(haloWidth)}" stroke-linejoin="round" />`,
    );
    shapes.push(
      `${geometry} fill="${mark.color}" fill-opacity="${MARK_FILL_OPACITY}" stroke="${mark.color}" stroke-width="${round2(strokeWidth)}" stroke-linejoin="round" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes.join('')}</svg>`;
}

function formatPolygonPoints(points: readonly number[]): string {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    pairs.push(`${round2(points[index])},${round2(points[index + 1])}`);
  }
  return pairs.join(' ');
}

function encodeCard(image: sharp.Sharp, format: OutputFormat): Promise<{ buffer: Buffer; contentType: string }> {
  if (format === 'png') {
    return image
      .png(PNG_OPTIONS)
      .toBuffer()
      .then((buffer) => ({ buffer, contentType: 'image/png' }));
  }
  if (format === 'webp') {
    return image
      .webp(WEBP_OPTIONS)
      .toBuffer()
      .then((buffer) => ({ buffer, contentType: 'image/webp' }));
  }
  return image
    .jpeg(JPEG_OPTIONS)
    .toBuffer()
    .then((buffer) => ({ buffer, contentType: 'image/jpeg' }));
}

/**
 * Render one spray-wall climb's share card, or answer `not-found`.
 *
 * Every visibility gate runs before `fetchPhotoBytes` is reachable, and they all
 * answer with the same `not-found`: a card that distinguished "no such wall"
 * from "a wall you may not see" would be an enumeration oracle over sequential
 * layout ids.
 */
export async function renderSprayOgCard(
  params: { layoutId: number; frames: string; format: OutputFormat },
  deps: SprayOgCardDeps,
): Promise<SprayOgCardResult> {
  const { layoutId, frames, format } = params;

  // 1. No wall, a soft-deleted wall, or a soft-deleted board.
  const wall = await deps.loadWall(layoutId);
  if (!wall) return { kind: 'not-found' };

  // 2. Public only. An unlisted wall is reachable by uuid inside the app and
  // still gets no card: an OG image is fetched by a crawler that holds no
  // capability at all, so "hard to guess" would be the whole access control.
  if (wall.isPublic !== true) return { kind: 'not-found' };

  // 3. A wall nobody has published has no photograph any climber has seen.
  if (wall.currentVersionId === null) return { kind: 'not-found' };

  // 4. The public copy SW-14 makes on promotion. Absent key, or no media bucket
  // in this environment, means there is nothing an unfurler could fetch.
  if (wall.publicPhotoKey === null) return { kind: 'not-found' };
  const photoUrl = deps.publicPhotoUrl(wall.publicPhotoKey);
  if (photoUrl === null) return { kind: 'not-found' };

  // 5. The published version carries the photo's pixel frame and its matrix.
  const version = await deps.loadPublishedVersion(wall.wallId);
  if (!version) return { kind: 'not-found' };

  const cacheKey = cardCacheKey({
    layoutId,
    currentVersionId: wall.currentVersionId,
    publicPhotoKey: wall.publicPhotoKey,
    frames,
    format,
  });
  const cached = cardCache.get(cacheKey);
  if (cached) {
    return {
      kind: 'card',
      buffer: cached.buffer,
      contentType: cached.contentType,
      timings: { photoMs: 0, composeMs: 0 },
    };
  }

  const photoT0 = performance.now();
  const [photoBytes, holds] = await Promise.all([deps.fetchPhotoBytes(photoUrl), deps.loadAliveHolds(wall.wallId)]);
  const photoMs = performance.now() - photoT0;

  const composeT0 = performance.now();
  // `fit: 'inside'` and a centred placement: a spray wall is photographed at
  // whatever aspect ratio the climber's phone produced, and cropping to 1200x630
  // would cut the top or the bottom off the wall the card is supposed to show.
  const placed = await sharp(photoBytes)
    .resize({ width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, fit: 'inside' })
    .toBuffer({ resolveWithObject: true });
  const placedWidth = placed.info.width;
  const placedHeight = placed.info.height;
  const left = Math.round((OG_IMAGE_WIDTH - placedWidth) / 2);
  const top = Math.round((OG_IMAGE_HEIGHT - placedHeight) / 2);

  const photoWidth = version.photoWidth ?? (await sharp(photoBytes).metadata()).width ?? placedWidth;
  const photoToPlaced = photoWidth > 0 ? placedWidth / photoWidth : 1;

  const overlaySvg = buildOverlayForWall({
    wall,
    holds,
    frames,
    homography: version.homography,
    placedWidth,
    placedHeight,
    photoToPlaced,
  });

  const composites: sharp.OverlayOptions[] = [{ input: placed.data, left, top }];
  if (overlaySvg !== null) composites.push({ input: Buffer.from(overlaySvg), left, top });

  const canvas = sharp({
    create: {
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      channels: 4,
      background: OG_FIELD_COLOR,
    },
  }).composite(composites);

  const { buffer, contentType } = await encodeCard(canvas, format);
  const composeMs = performance.now() - composeT0;

  cardCache.set(cacheKey, { buffer, contentType });
  return { kind: 'card', buffer, contentType, timings: { photoMs, composeMs } };
}

/**
 * The overlay, or null when the wall's matrix cannot be inverted.
 *
 * `invert` throws on a singular matrix by design — it is handed something the
 * system itself stored, so a singular one is an upstream bug. It is not a reason
 * to break a shared link: a card with no holds on it is a worse card, a 500 on a
 * link somebody already posted is a broken one.
 */
function buildOverlayForWall(params: {
  wall: SprayOgWallRow;
  holds: readonly SprayOgHold[];
  frames: string;
  homography: number[] | null;
  placedWidth: number;
  placedHeight: number;
  photoToPlaced: number;
}): string | null {
  let canonicalToPhoto: Homography;
  try {
    canonicalToPhoto = invert(params.homography ?? IDENTITY_HOMOGRAPHY);
  } catch (error) {
    logger.warn('[SprayOGCard] singular homography, rendering the photo without holds', {
      layoutId: params.wall.layoutId,
      wallId: params.wall.wallId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const marks = buildSprayOverlayMarks({
    holds: params.holds,
    frames: params.frames,
    canonicalToPhoto,
    photoToPlaced: params.photoToPlaced,
  });
  if (marks.length === 0) return null;

  return buildSprayOverlaySvg({ width: params.placedWidth, height: params.placedHeight, marks });
}

/** The production dependency set, wired to drizzle + the media bucket + fetch. */
export function createSprayOgCardDeps(): SprayOgCardDeps {
  return {
    loadWall: async (layoutId) => {
      const [row] = await db
        .select({
          wallId: sprayWalls.id,
          layoutId: sprayWalls.layoutId,
          wallName: userBoards.name,
          isPublic: userBoards.isPublic,
          publicPhotoKey: sprayWalls.publicPhotoKey,
          currentVersionId: sprayWalls.currentVersionId,
        })
        .from(sprayWalls)
        .innerJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
        .where(and(eq(sprayWalls.layoutId, layoutId), isNull(sprayWalls.deletedAt), isNull(userBoards.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    loadPublishedVersion: async (wallId) => {
      const [row] = await db
        .select({
          photoWidth: sprayWallVersions.photoWidth,
          photoHeight: sprayWallVersions.photoHeight,
          homography: sprayWallVersions.homography,
        })
        .from(sprayWalls)
        .innerJoin(sprayWallVersions, eq(sprayWallVersions.id, sprayWalls.currentVersionId))
        .where(eq(sprayWalls.id, wallId))
        .limit(1);
      return row ?? null;
    },

    loadAliveHolds: async (wallId) => {
      const rows = await aliveHolds(db, wallId);
      return rows.map((hold) => ({
        holdId: hold.holdId,
        cx: hold.cx,
        cy: hold.cy,
        r: hold.r,
        outline: hold.outline ?? null,
      }));
    },

    fetchPhotoBytes: async (photoUrl) => {
      const response = await fetch(photoUrl);
      if (!response.ok) {
        throw new Error(`spray wall photo fetch failed with ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },

    // Never presigned. An unfurler cannot hold a 15-minute signature and the card
    // is cached for a day, so the only URL that can appear here is the public
    // `media` copy promotion writes.
    publicPhotoUrl: (photoKey) => {
      if (!isS3Configured('media')) return null;
      try {
        return getPublicUrl('media', photoKey);
      } catch {
        return null;
      }
    },
  };
}
