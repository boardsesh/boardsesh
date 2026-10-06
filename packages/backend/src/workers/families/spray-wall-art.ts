import { z } from 'zod';
import sharp from 'sharp';
import { and, eq, isNull } from 'drizzle-orm';
import { aliveHolds } from '@boardsesh/db/queries';
import { sprayWallVersions, sprayWalls, type SprayWallVersionArt } from '@boardsesh/db/schema';
import {
  ART_RECIPE,
  artFeather,
  canonicalArtSize,
  holdMaskRings,
  invert,
  warpBilinear,
  type ArtMaskRing,
} from '@boardsesh/spray-wall-geometry';
import { deleteFromS3, getFromS3Strict, isS3Configured, uploadToS3 } from '../../storage/s3';
import { streamToBuffer, writeImageVariants } from '../../lib/image-resize';
import {
  SPRAY_WALL_ART_CACHE_CONTROL,
  SPRAY_WALL_ART_CROP_CONTENT_TYPE,
  SPRAY_WALL_ART_CUTOUT_CONTENT_TYPE,
  SPRAY_WALL_ART_DEADLINE_SECONDS,
  SPRAY_WALL_ART_FAMILY,
  SPRAY_WALL_ART_THUMBNAIL_SIZE,
  refusedArt,
  sprayVersionQuality,
  sprayWallArtCutoutThumbKey,
  sprayWallArtKeys,
  sprayWallArtSingletonKey,
} from '../../lib/spray-wall-art';
import { logger } from '../../utils/logger';
import { boundedErrorFields } from './job-logging';
import { BackgroundJobError, type BackgroundJobContext, type BackgroundJobFamilyModule } from './types';

/**
 * `spray-wall-art`: render one version's generated wall looks (`docs/spray-walls.md`,
 * "Generated wall looks").
 *
 * - **Wall only** (`-crop.jpg`): the version's photo warped into the canonical
 *   frame through the inverse of its stored homography. The room falls outside
 *   the pinned quad, so there is nothing to mask.
 * - **Holds only** (`-cutout.webp`): the same pixels with an alpha channel that
 *   is opaque only on the holds alive at this version, each filled from its
 *   outline (or a circle), grown by 4% of its radius and feathered. Clients
 *   draw the Aura field colour behind it.
 *
 * Holds are stored in the canonical frame already, so the mask is drawn there
 * directly; only the photo is warped.
 *
 * Every write is the version's `art` column, under the attempt fence. The
 * quality gate is re-checked here with the shared function, so a job queued by
 * an older backend cannot render a photo the gate now refuses.
 */
const payload = z
  .object({
    versionId: z.number().int().positive(),
    recipe: z.number().int().positive(),
  })
  .strict();

type Payload = z.infer<typeof payload>;

const CROP_JPEG_QUALITY = 88;
const CUTOUT_WEBP_QUALITY = 88;

/** One SVG polygon per hold: filled, and stroked round by twice its grow to dilate it. */
export function holdMaskSvg(rings: readonly ArtMaskRing[], width: number, height: number): string {
  const polygons = rings
    .map((ring) => {
      const points: string[] = [];
      for (let index = 0; index + 1 < ring.points.length; index += 2) {
        points.push(`${ring.points[index].toFixed(1)},${ring.points[index + 1].toFixed(1)}`);
      }
      return `<polygon points="${points.join(' ')}" stroke-width="${ring.grow * 2}"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#000"/>` +
    `<g fill="#fff" stroke="#fff" stroke-linejoin="round">${polygons}</g></svg>`
  );
}

async function writeArtFailure(context: BackgroundJobContext, versionId: number, code: string): Promise<void> {
  try {
    await context.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ art: sprayWallVersions.art })
        .from(sprayWallVersions)
        .where(eq(sprayWallVersions.id, versionId))
        .limit(1);
      // A finished image from an earlier attempt is worth more than this failure.
      if (!current || current.art?.status === 'ready') return;
      const failed: SprayWallVersionArt = {
        recipe: ART_RECIPE,
        status: 'failed',
        width: null,
        height: null,
        cropKey: null,
        cutoutKey: null,
        quality: current.art?.quality ?? null,
        error: code,
        requestedAt: current.art?.requestedAt ?? null,
      };
      await transaction.update(sprayWallVersions).set({ art: failed }).where(eq(sprayWallVersions.id, versionId));
    });
  } catch (error) {
    logger.warn('[spray-wall-art] could not record the failure', { versionId, code, ...boundedErrorFields(error) });
  }
}

async function render(context: BackgroundJobContext, request: Payload): Promise<void> {
  const [row] = await context.database
    .select({
      versionId: sprayWallVersions.id,
      wallId: sprayWallVersions.wallId,
      versionNumber: sprayWallVersions.versionNumber,
      photoKey: sprayWallVersions.photoKey,
      photoWidth: sprayWallVersions.photoWidth,
      photoHeight: sprayWallVersions.photoHeight,
      anchors: sprayWallVersions.anchors,
      homography: sprayWallVersions.homography,
      boardUuid: sprayWalls.boardUuid,
      referenceWidth: sprayWalls.referenceWidth,
      referenceHeight: sprayWalls.referenceHeight,
    })
    .from(sprayWallVersions)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallVersions.wallId))
    .where(and(eq(sprayWallVersions.id, request.versionId), isNull(sprayWalls.deletedAt)))
    .limit(1);
  // A deleted wall or a vanished version: nothing to render and nobody to show it to.
  if (!row) throw new BackgroundJobError('SPRAY_ART_VERSION_MISSING', { retryable: false });

  const quality = sprayVersionQuality(row, row);
  if (quality.verdict === 'fail') {
    await context.transaction(async (transaction) => {
      await transaction
        .update(sprayWallVersions)
        .set({ art: refusedArt(quality) })
        .where(eq(sprayWallVersions.id, row.versionId));
    });
    logger.info('[spray-wall-art] refused by the quality gate', {
      runId: context.runId,
      versionId: row.versionId,
      reason: quality.reason,
      stretch: quality.stretch,
    });
    return;
  }

  if (!row.photoKey || !row.homography) {
    throw new BackgroundJobError('SPRAY_ART_PHOTO_MISSING', { retryable: false });
  }

  const object = await getFromS3Strict('private', row.photoKey);
  if (!object) throw new BackgroundJobError('SPRAY_ART_PHOTO_MISSING', { retryable: false });
  const photoBytes = await streamToBuffer(object.stream);

  let photo: { data: Buffer; info: sharp.OutputInfo };
  try {
    photo = await sharp(photoBytes).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new BackgroundJobError('SPRAY_ART_PHOTO_UNDECODABLE', { retryable: false });
  }
  // The homography is in the stored photo's pixels. A decode of another size
  // would put every pixel of the art in the wrong place.
  if (
    (row.photoWidth != null && photo.info.width !== row.photoWidth) ||
    (row.photoHeight != null && photo.info.height !== row.photoHeight)
  ) {
    throw new BackgroundJobError('SPRAY_ART_PHOTO_SIZE_MISMATCH', { retryable: false });
  }

  let canonicalToPhoto: number[];
  try {
    canonicalToPhoto = invert(row.homography);
  } catch {
    throw new BackgroundJobError('SPRAY_ART_SINGULAR_HOMOGRAPHY', { retryable: false });
  }

  const frame = { width: row.referenceWidth ?? 0, height: row.referenceHeight ?? 0 };
  const size = canonicalArtSize(frame);
  const channels = photo.info.channels;
  const warped = warpBilinear(
    new Uint8Array(photo.data.buffer, photo.data.byteOffset, photo.data.byteLength),
    photo.info.width,
    photo.info.height,
    channels,
    canonicalToPhoto,
    size.width,
    size.height,
    size.scale,
  );
  const raw = { raw: { width: size.width, height: size.height, channels } } as const;

  const holds = await aliveHolds(context.database, row.wallId, row.versionNumber);
  const rings = holdMaskRings(holds, size.scale);
  const sigma = artFeather(
    holds.map((hold) => hold.r),
    size.scale,
  );
  const mask = await sharp(Buffer.from(holdMaskSvg(rings, size.width, size.height)))
    .resize(size.width, size.height)
    .blur(sigma)
    .extractChannel(0)
    .raw()
    .toBuffer();

  const crop = await sharp(warped, raw).jpeg({ quality: CROP_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  const cutout = await sharp(warped, raw)
    .joinChannel(mask, { raw: { width: size.width, height: size.height, channels: 1 } })
    .webp({ quality: CUTOUT_WEBP_QUALITY, alphaQuality: 100 })
    .toBuffer();
  const cutoutThumb = await sharp(cutout)
    .resize(SPRAY_WALL_ART_THUMBNAIL_SIZE, SPRAY_WALL_ART_THUMBNAIL_SIZE, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 80, alphaQuality: 100 })
    .toBuffer();

  // Thumbnails before their base, as the photo does, so a reader that can see
  // an image can always see its thumbnail. Overwrites are safe: the recipe is in
  // the key and the pixels for one key never change.
  const { cropKey, cutoutKey } = sprayWallArtKeys(row.boardUuid, row.versionId, ART_RECIPE);
  const written: string[] = [];
  const put = (key: string, body: Buffer, contentType: string) => {
    written.push(key);
    return uploadToS3('private', body, key, contentType, {
      acl: null,
      cacheControl: SPRAY_WALL_ART_CACHE_CONTROL,
      abortSignal: context.signal,
    });
  };
  await writeImageVariants(crop, cropKey, put, [SPRAY_WALL_ART_THUMBNAIL_SIZE], SPRAY_WALL_ART_CROP_CONTENT_TYPE);
  await put(sprayWallArtCutoutThumbKey(cutoutKey), cutoutThumb, SPRAY_WALL_ART_CUTOUT_CONTENT_TYPE);
  await put(cropKey, crop, SPRAY_WALL_ART_CROP_CONTENT_TYPE);
  await put(cutoutKey, cutout, SPRAY_WALL_ART_CUTOUT_CONTENT_TYPE);

  const ready: SprayWallVersionArt = {
    recipe: ART_RECIPE,
    status: 'ready',
    width: size.width,
    height: size.height,
    cropKey,
    cutoutKey,
    quality: { stretch: quality.stretch, verdict: quality.verdict },
    error: null,
  };
  const stillLive = await context.transaction(async (transaction) => {
    const [wall] = await transaction
      .select({ id: sprayWalls.id })
      .from(sprayWalls)
      .where(and(eq(sprayWalls.id, row.wallId), isNull(sprayWalls.deletedAt)))
      .limit(1);
    if (!wall) return false;
    await transaction.update(sprayWallVersions).set({ art: ready }).where(eq(sprayWallVersions.id, row.versionId));
    return true;
  });
  if (!stillLive) {
    // Deleted while this rendered. The retention purge may already have swept
    // the prefix, and it never sweeps a wall twice, so take back what this job
    // wrote rather than leave it in the bucket with nothing naming it.
    for (const key of written) {
      await deleteFromS3('private', key).catch((error: unknown) =>
        logger.warn('[spray-wall-art] could not delete art of a deleted wall', { key, ...boundedErrorFields(error) }),
      );
    }
    throw new BackgroundJobError('SPRAY_ART_VERSION_MISSING', { retryable: false });
  }
  logger.info('[spray-wall-art] rendered', {
    runId: context.runId,
    versionId: row.versionId,
    width: size.width,
    height: size.height,
    holds: holds.length,
    verdict: quality.verdict,
    cropBytes: crop.length,
    cutoutBytes: cutout.length,
  });
}

export const sprayWallArtFamily: BackgroundJobFamilyModule<Payload> = {
  name: SPRAY_WALL_ART_FAMILY,
  roles: ['maintenance-delivery'],
  payload,
  options: {
    expireInSeconds: 300,
    heartbeatSeconds: 30,
    deadlineSeconds: SPRAY_WALL_ART_DEADLINE_SECONDS,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
  },
  singletonKey: sprayWallArtSingletonKey,
  async execute(context, request) {
    const startedAtMs = Date.now();
    try {
      // Inside the try, so a worker with no bucket records `failed` rather
      // than leaving the row pending.
      if (!isS3Configured('private')) throw new BackgroundJobError('SPRAY_ART_STORAGE_UNAVAILABLE');
      await render(context, request);
    } catch (error) {
      const code = error instanceof BackgroundJobError ? error.code : 'SPRAY_ART_RENDER_FAILED';
      logger.warn('[spray-wall-art] render failed', {
        runId: context.runId,
        versionId: request.versionId,
        code,
        durationMs: Date.now() - startedAtMs,
        ...boundedErrorFields(error),
      });
      if (code !== 'SPRAY_ART_VERSION_MISSING') await writeArtFailure(context, request.versionId, code);
      throw error;
    }
  },
};
