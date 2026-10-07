import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import type { SprayWallVersionArt } from '@boardsesh/db/schema';
import { ART_RECIPE, type PhotoQuality } from '@boardsesh/spray-wall-geometry';
import { enqueueBackgroundJobOn } from '../workers/jobs';
import { getJobQueue } from './job-queue';
import { enabledBatchFamiliesOrNone } from './batch-schedules';
import { isS3Configured, presignGetObject } from '../storage/s3';
import { resizedVariantKey } from '../lib/image-resize';
import {
  type SprayWallArtState,
  SPRAY_WALL_ART_FAMILY,
  sprayWallArtState,
  SPRAY_WALL_ART_THUMBNAIL_SIZE,
  artIsCurrent,
  refusedArt,
  sprayVersionQuality,
  sprayWallArtCutoutThumbKey,
  sprayWallArtSingletonKey,
} from '../lib/spray-wall-art';
import { logger } from '../utils/logger';

/**
 * The producer half of the generated wall looks (`docs/spray-walls.md`,
 * "Generated wall looks"): deciding whether a version gets art, queueing the
 * `spray-wall-art` job, and presigning what it made.
 */

type VersionRow = typeof dbSchema.sprayWallVersions.$inferSelect;
type WallFrame = { referenceWidth: number | null; referenceHeight: number | null };

export type SprayWallArtRequestOutcome = 'queued' | 'refused' | 'unavailable' | 'current';

/**
 * Ask for one version's art, inside the caller's transaction.
 *
 * - quality `fail`: writes `refused` and queues nothing;
 * - art already `ready` for the running recipe: leaves it alone;
 * - otherwise queues the job and writes `pending`, unless the family is off
 *   (`BATCH_FAMILIES_DISABLED`) or no queue is running, in which case nothing
 *   is written and the version stays on its photo.
 *
 * Never throws into the caller. Art is optional; a publish must not fail
 * because the queue did. The work runs in a savepoint so a failed enqueue
 * rolls back only itself.
 */
/**
 * Anything that can open a (nested) transaction: the pool, or a transaction a
 * caller already holds, where it becomes a savepoint.
 */
type SavepointOpener = {
  transaction<T>(callback: (savepoint: BackgroundJobTransaction) => Promise<T>): Promise<T>;
};

export async function requestSprayWallArtOn(
  transaction: SavepointOpener,
  version: Pick<VersionRow, 'id' | 'anchors' | 'homography' | 'photoKey' | 'art'>,
  wall: WallFrame,
  options: { failureLevel?: 'error' | 'warn' } = {},
): Promise<SprayWallArtRequestOutcome> {
  try {
    return await transaction.transaction(async (savepoint) => {
      const quality = sprayVersionQuality(version, wall);
      if (quality.verdict === 'fail') {
        await savepoint
          .update(dbSchema.sprayWallVersions)
          .set({ art: refusedArt(quality) })
          .where(eq(dbSchema.sprayWallVersions.id, version.id));
        return 'refused';
      }
      if (artIsCurrent(version.art) && version.art.status === 'ready') return 'current';
      if (!version.photoKey) return 'unavailable';

      const boss = sprayWallArtProducer();
      if (!boss) return 'unavailable';

      const jobPayload = { versionId: version.id, recipe: ART_RECIPE };
      await enqueueBackgroundJobOn(savepoint, boss, {
        family: SPRAY_WALL_ART_FAMILY,
        payload: jobPayload,
        singletonKey: sprayWallArtSingletonKey(jobPayload),
      });
      const pending: SprayWallVersionArt = {
        recipe: ART_RECIPE,
        status: 'pending',
        width: null,
        height: null,
        cropKey: null,
        cutoutKey: null,
        quality: { stretch: quality.stretch, verdict: quality.verdict },
        error: null,
        requestedAt: new Date().toISOString(),
      };
      // Not over a `ready` row of this recipe: a job that finished between the
      // caller's read and this write has already done the work.
      await savepoint
        .update(dbSchema.sprayWallVersions)
        .set({ art: pending })
        .where(
          and(
            eq(dbSchema.sprayWallVersions.id, version.id),
            or(
              isNull(dbSchema.sprayWallVersions.art),
              sql`${dbSchema.sprayWallVersions.art}->>'status' <> 'ready'`,
              sql`(${dbSchema.sprayWallVersions.art}->>'recipe')::int <> ${ART_RECIPE}`,
            ),
          ),
        );
      return 'queued';
    });
  } catch (error) {
    if (options.failureLevel === 'warn') {
      logger.warn('[spray-wall-art] could not request art', { versionId: version.id }, error);
    } else {
      logger.error('[spray-wall-art] could not request art', { versionId: version.id }, error);
    }
    return 'unavailable';
  }
}

/** The queue to send art jobs on, or null while the family is off or no queue is running. */
function sprayWallArtProducer() {
  return enabledBatchFamiliesOrNone().has(SPRAY_WALL_ART_FAMILY) ? getJobQueue() : null;
}

/**
 * At most one read-path request per version per this window, per process. A
 * read can come from anybody who can see the wall, logged out included, so a
 * queue outage must not turn every read into a transaction and a log line.
 */
export const SPRAY_WALL_ART_READ_REQUEUE_THROTTLE_MS = 10 * 60 * 1000;
const READ_REQUEUE_MAX_ENTRIES = 5000;
const lastReadRequeueAt = new Map<number, number>();

/** Forget the read-path throttle. Test seam: the map is module state. */
export function resetSprayWallArtReadThrottle(): void {
  lastReadRequeueAt.clear();
}

/**
 * The read-time backfill's request (`sprayWallArt`): queue only, never
 * render. Opens no transaction when the family is off or no queue is running,
 * is throttled per version, and logs a failure at `warn` rather than `error`
 * (a publish's failure stays `error`). Never throws.
 */
export async function requestSprayWallArtFromRead(
  database: SavepointOpener,
  version: Pick<VersionRow, 'id' | 'anchors' | 'homography' | 'photoKey' | 'art'>,
  wall: WallFrame,
  nowMs: number = Date.now(),
): Promise<SprayWallArtRequestOutcome> {
  if (!sprayWallArtProducer()) return 'unavailable';
  const last = lastReadRequeueAt.get(version.id);
  if (last !== undefined && nowMs - last < SPRAY_WALL_ART_READ_REQUEUE_THROTTLE_MS) return 'unavailable';
  if (lastReadRequeueAt.size >= READ_REQUEUE_MAX_ENTRIES) {
    const oldest = lastReadRequeueAt.keys().next();
    if (!oldest.done) lastReadRequeueAt.delete(oldest.value);
  }
  lastReadRequeueAt.delete(version.id);
  lastReadRequeueAt.set(version.id, nowMs);
  try {
    return await requestSprayWallArtOn(database, version, wall, { failureLevel: 'warn' });
  } catch (error) {
    logger.warn('[spray-wall-art] could not request art', { versionId: version.id }, error);
    return 'unavailable';
  }
}

/**
 * Whether a choice of generated background should (re)queue art for a version:
 * no art yet, an older recipe, or a run that failed or never finished. A
 * `pending` row whose job is still queued is deduplicated by the singleton key.
 */
export function sprayWallArtNeedsRequest(art: SprayWallVersionArt | null | undefined): boolean {
  if (!artIsCurrent(art)) return true;
  // `refused` too: the caller has just checked the live gate and it passed, so
  // the stored refusal is from an older gate or an older version of the pins.
  return art.status !== 'ready';
}

export type PresignedSprayWallArtImage = {
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  expiresAt: string;
};

async function presignArtImage(
  key: string,
  thumbKey: string,
  width: number | null,
  height: number | null,
): Promise<PresignedSprayWallArtImage> {
  const [image, thumb] = await Promise.all([
    presignGetObject('private', key),
    presignGetObject('private', thumbKey).catch(() => null),
  ]);
  return { url: image.url, thumbUrl: thumb?.url ?? null, width, height, expiresAt: image.expiresAt };
}

export type SprayWallArtView = {
  versionNumber: number;
  recipe: number;
  status: 'NONE' | 'PENDING' | 'READY' | 'FAILED' | 'REFUSED';
  width: number | null;
  height: number | null;
  quality: { stretch: number | null; verdict: 'GOOD' | 'SOFT' | 'FAIL'; reason: string; frameShortEdge: number };
  crop: PresignedSprayWallArtImage | null;
  cutout: PresignedSprayWallArtImage | null;
};

function qualityView(quality: PhotoQuality): SprayWallArtView['quality'] {
  return {
    stretch: quality.stretch,
    verdict: quality.verdict === 'good' ? 'GOOD' : quality.verdict === 'soft' ? 'SOFT' : 'FAIL',
    reason: quality.reason,
    frameShortEdge: quality.frameShortEdge,
  };
}

/**
 * The `SprayWallArt` a reader sees for one version. The caller has already
 * applied the wall's view rule; a presigned URL bypasses every other gate.
 *
 * The quality verdict is computed live from the version's pins, so a client
 * can grey out the generated backgrounds before any job has run. The status is
 * `sprayWallArtState`; a ready row whose signature cannot be minted reads as
 * `PENDING` rather than handing out a dead URL.
 */
export async function sprayWallArtView(
  version: VersionRow,
  wall: WallFrame,
  state: SprayWallArtState = sprayWallArtState(version.art, sprayVersionQuality(version, wall).verdict === 'fail'),
): Promise<SprayWallArtView> {
  const quality = qualityView(sprayVersionQuality(version, wall));
  const base = {
    versionNumber: version.versionNumber,
    recipe: ART_RECIPE,
    width: null,
    height: null,
    quality,
    crop: null,
    cutout: null,
  };
  const art = version.art;
  if (state.status !== 'READY' || !art) return { ...base, status: state.status };
  if (!art.cropKey || !art.cutoutKey || !isS3Configured('private')) return { ...base, status: 'PENDING' };

  try {
    const [crop, cutout] = await Promise.all([
      presignArtImage(
        art.cropKey,
        resizedVariantKey(art.cropKey, SPRAY_WALL_ART_THUMBNAIL_SIZE),
        art.width,
        art.height,
      ),
      presignArtImage(art.cutoutKey, sprayWallArtCutoutThumbKey(art.cutoutKey), art.width, art.height),
    ]);
    return { ...base, status: 'READY', width: art.width, height: art.height, crop, cutout };
  } catch (error) {
    logger.warn('[spray-wall-art] could not presign art', { versionId: version.id }, error);
    return { ...base, status: 'PENDING' };
  }
}
