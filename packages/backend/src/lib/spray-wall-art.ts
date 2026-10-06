/**
 * The generated wall looks of a spray wall version: where they are stored, how
 * a job is keyed, and the quality verdict both the producer and the worker
 * read. No database, queue or HTTP imports, so the worker family and the
 * resolvers can both use it (`docs/spray-walls.md`, "Generated wall looks").
 */
import {
  ART_RECIPE,
  type PhotoQuality,
  type Quad,
  isValidAnchorQuad,
  photoQuality,
} from '@boardsesh/spray-wall-geometry';
import type { SprayWallVersionArt } from '@boardsesh/db/schema';

export const SPRAY_WALL_ART_FAMILY = 'spray-wall-art';

/**
 * The job's absolute deadline across every retry. A `pending` (or `failed`)
 * row older than this has no run left that will ever finish it: a crash, an
 * expired lease or the deadline itself writes no final state. Readers treat
 * such a row as FAILED, and a read of a wall that chose generated art
 * re-queues it.
 */
export const SPRAY_WALL_ART_DEADLINE_SECONDS = 3600;

/**
 * The same cache rule as the stored photo: art is cut from a photograph of
 * somebody's home and lives in the private bucket behind signatures.
 */
export const SPRAY_WALL_ART_CACHE_CONTROL = 'private, no-store';

export const SPRAY_WALL_ART_CROP_CONTENT_TYPE = 'image/jpeg';
export const SPRAY_WALL_ART_CUTOUT_CONTENT_TYPE = 'image/webp';

/** The list-row thumbnail size, the same one the photo writes. */
export const SPRAY_WALL_ART_THUMBNAIL_SIZE = 280;

export type SprayWallArtJobPayload = { versionId: number; recipe: number };

/**
 * The two object keys of one version's art. Under the wall's own
 * `spray-walls/<wallUuid>/` prefix, so the retention purge and account deletion
 * delete them with the photo; the recipe is in the key, so a recipe bump never
 * overwrites an object a client may still be reading.
 */
export function sprayWallArtKeys(
  wallUuid: string,
  versionId: number,
  recipe: number = ART_RECIPE,
): { cropKey: string; cutoutKey: string } {
  const stem = `spray-walls/${wallUuid}/art/${versionId}-r${recipe}`;
  return { cropKey: `${stem}-crop.jpg`, cutoutKey: `${stem}-cutout.webp` };
}

/**
 * The cutout's thumbnail key. Not `resizedVariantKey`, which always names a
 * JPEG: a JPEG has no alpha, and the whole cutout is its alpha.
 */
export function sprayWallArtCutoutThumbKey(cutoutKey: string): string {
  return `${cutoutKey}@${SPRAY_WALL_ART_THUMBNAIL_SIZE}.webp`;
}

export function sprayWallArtSingletonKey(payload: SprayWallArtJobPayload): string {
  return `art:${payload.versionId}:${payload.recipe}`;
}

type VersionGeometry = {
  anchors: [number, number][] | null;
  homography: number[] | null;
};

type WallFrame = { referenceWidth: number | null; referenceHeight: number | null };

/**
 * The quality verdict of one version against its wall's canonical frame.
 *
 * Pins first, because pins tapped on the photo's own corners solve to the
 * identity, which as a bare matrix reads as "no pins". A version with no pins
 * at all fails.
 */
export function sprayVersionQuality(version: VersionGeometry, wall: WallFrame): PhotoQuality {
  const frame = { width: wall.referenceWidth ?? 0, height: wall.referenceHeight ?? 0 };
  const pins: Quad | null = isValidAnchorQuad(version.anchors) ? version.anchors : null;
  return photoQuality(pins ?? (version.anchors == null ? null : version.homography), frame);
}

/** Whether a stored art row was made (or is being made) by the running recipe. */
export function artIsCurrent(art: SprayWallVersionArt | null | undefined): art is SprayWallVersionArt {
  return art != null && art.recipe === ART_RECIPE;
}

/** The art row a refused photo gets. Nothing is rendered or queued for it. */
export function refusedArt(quality: PhotoQuality): SprayWallVersionArt {
  return {
    recipe: ART_RECIPE,
    status: 'refused',
    width: null,
    height: null,
    cropKey: null,
    cutoutKey: null,
    quality: { stretch: quality.stretch, verdict: quality.verdict },
    error: quality.reason,
    requestedAt: null,
  };
}

export type SprayWallArtState = {
  status: 'NONE' | 'PENDING' | 'READY' | 'FAILED' | 'REFUSED';
  /** Whether a reader that wants this art should queue the job again. */
  requeue: boolean;
};

function olderThanDeadline(requestedAt: string | null | undefined, nowMs: number): boolean {
  const at = requestedAt ? Date.parse(requestedAt) : Number.NaN;
  return !Number.isFinite(at) || nowMs - at > SPRAY_WALL_ART_DEADLINE_SECONDS * 1000;
}

/**
 * What a stored art row means right now. `liveFail` is the live quality gate.
 *
 * - READY for the running recipe is served, whatever the live gate says: the
 *   job checked the same immutable geometry before it rendered.
 * - Otherwise a live fail is REFUSED, and never re-queued.
 * - No art, an older recipe, or a refusal the live gate no longer agrees with:
 *   NONE, re-queue.
 * - `failed`: FAILED; re-queue once it is older than the deadline, so a
 *   permanent failure is retried at most hourly rather than on every read.
 * - `pending` older than the deadline: FAILED (no run left will finish it),
 *   re-queue. Fresher: PENDING.
 */
export function sprayWallArtState(
  art: SprayWallVersionArt | null | undefined,
  liveFail: boolean,
  nowMs: number = Date.now(),
): SprayWallArtState {
  if (artIsCurrent(art) && art.status === 'ready') return { status: 'READY', requeue: false };
  if (liveFail) return { status: 'REFUSED', requeue: false };
  if (!artIsCurrent(art) || art.status === 'refused') return { status: 'NONE', requeue: true };
  const stale = olderThanDeadline(art.requestedAt, nowMs);
  if (art.status === 'failed') return { status: 'FAILED', requeue: stale };
  return stale ? { status: 'FAILED', requeue: true } : { status: 'PENDING', requeue: false };
}
