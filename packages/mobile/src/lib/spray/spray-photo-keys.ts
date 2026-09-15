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
 * Background manifest keys for a wall look like `spray/<layoutId>/<version>.jpg`.
 *
 * A path rather than a flat name so it can never collide with a bundled board's
 * manifest key, which is always `<boardName>/...` for one of the eight catalogue
 * boards, and so `background-image-cache.ts` can route on the `spray/` prefix
 * alone.
 */
export const SPRAY_BACKGROUND_KEY_PREFIX = 'spray/';

export type SprayPhotoIdentity = { layoutId: number; version: number };

export function sprayBackgroundKey(layoutId: number, version: number): string {
  return `${SPRAY_BACKGROUND_KEY_PREFIX}${layoutId}/${version}.jpg`;
}

/** Parse a `spray/<layoutId>/<version>.jpg` key, or `null` when it is not one. */
export function parseSprayBackgroundKey(backgroundImageKey: string): SprayPhotoIdentity | null {
  const match = /^spray\/(\d+)\/(\d+)\.jpg$/.exec(backgroundImageKey);
  if (!match) return null;
  return { layoutId: Number(match[1]), version: Number(match[2]) };
}

/**
 * The filename a wall version's photo is stored under. Also what the sweeper
 * matches on, which is why the version is in it: two generations of one wall are
 * two different photographs and must never share a file.
 */
export function sprayPhotoFileName(identity: SprayPhotoIdentity): string {
  return `${identity.layoutId}-${identity.version}.jpg`;
}

/**
 * Suffix a download stages under before it is moved into place. The sweeper
 * refuses to delete anything carrying it (`planSprayPhotoSweep`), so the two must
 * agree — hence one constant rather than two literals.
 */
export const SPRAY_PARTIAL_SUFFIX = '.part';

/** Where a download lands before it is complete. */
export function sprayPartialPhotoFileName(identity: SprayPhotoIdentity): string {
  return `${sprayPhotoFileName(identity)}${SPRAY_PARTIAL_SUFFIX}`;
}
