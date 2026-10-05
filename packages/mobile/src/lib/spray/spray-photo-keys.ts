// Names and keys for the wall-photo cache, with no imports at all.
//
// Split out of `spray-photo-cache.ts` for the reason `snapshot-paths.ts` is
// split out of `snapshot-source.ts`: the render path (`board-details.ts`) and the
// cache sweeper both need to NAME a wall photo, and neither should drag
// `expo-file-system` into its module graph to do it — that module has no browser
// build and no Vitest one either, so a pure key helper living beside the I/O
// would make every consumer untestable.

/** Cache subdirectory under `Paths.cache`. */
export const SPRAY_PHOTO_CACHE_DIR_NAME = 'spray-walls';

/**
 * Background manifest keys for a wall look like `spray/<layoutId>/v<versionId>.jpg`.
 *
 * A path rather than a flat name so it can never collide with a bundled board's
 * manifest key, which is always `<boardName>/...` for one of the eight catalogue
 * boards, and so `background-image-cache.ts` can route on the `spray/` prefix
 * alone.
 */
export const SPRAY_BACKGROUND_KEY_PREFIX = 'spray/';

/** Local published mirrors have no database row id; their photo UUID and published number are immutable together. */
export type SprayVersionIdentity = number | `local-${string}`;
export type SprayPhotoIdentity = { layoutId: number; versionId: SprayVersionIdentity };

export function isSprayVersionIdentity(identity: SprayVersionIdentity): boolean {
  if (typeof identity === 'number') return Number.isSafeInteger(identity) && identity > 0;
  const match = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([1-9]\d*)$/i.exec(identity);
  return match != null && Number.isSafeInteger(Number(match[1]));
}

export function sprayBackgroundKey(layoutId: number, versionId: SprayVersionIdentity): string {
  return `${SPRAY_BACKGROUND_KEY_PREFIX}${layoutId}/v${versionId}.jpg`;
}

/** Parse a `spray/<layoutId>/v<versionId>.jpg` key, or `null` when it is not one. */
export function parseSprayBackgroundKey(backgroundImageKey: string): SprayPhotoIdentity | null {
  const match = /^spray\/(\d+)\/v(\d+|local-[0-9a-f-]{36}-[1-9]\d*)\.jpg$/i.exec(backgroundImageKey);
  if (!match) return null;
  const versionId = match[2].startsWith('local-') ? (match[2] as SprayVersionIdentity) : Number(match[2]);
  return isSprayVersionIdentity(versionId) ? { layoutId: Number(match[1]), versionId } : null;
}

/**
 * The filename a wall version's photo is stored under. Also what the sweeper
 * matches on, which is why the version is in it: two generations of one wall are
 * two different photographs and must never share a file.
 */
export function sprayPhotoFileName(identity: SprayPhotoIdentity): string {
  return `${identity.layoutId}-v${identity.versionId}.jpg`;
}

/**
 * Suffix a download stages under before it is moved into place. The sweeper
 * refuses to delete anything carrying it (`planSprayPhotoSweep`), so the two must
 * agree. `cache-sweep-plan.ts` keeps its own copy rather than importing this one —
 * that module is deliberately import-free so its rules stay testable without a
 * filesystem — and a test pins the two values together.
 */
export const SPRAY_PARTIAL_SUFFIX = '.part';

/** Where a download lands before it is complete. */
export function sprayPartialPhotoFileName(identity: SprayPhotoIdentity): string {
  return `${sprayPhotoFileName(identity)}${SPRAY_PARTIAL_SUFFIX}`;
}
