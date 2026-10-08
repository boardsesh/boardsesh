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

/**
 * A generated wall look stored beside a version's photo (`sprayWallArt`):
 * `crop` is "Wall only" (a JPEG), `cutout` is "Holds only" (a WebP with alpha).
 * Absent on an identity means the raw photo.
 */
export type SprayArtVariant = 'crop' | 'cutout';

export type SprayPhotoIdentity = {
  layoutId: number;
  versionId: SprayVersionIdentity;
  /** Left out for the raw photo, so every key and name the photo had before art existed is unchanged. */
  variant?: SprayArtVariant;
};

/** What a variant's file name ends in. The photo's own suffix is `.jpg`. */
const VARIANT_SUFFIX: Record<SprayArtVariant, string> = { crop: '-crop.jpg', cutout: '-cutout.webp' };

function variantSuffix(variant: SprayArtVariant | undefined): string {
  return variant ? VARIANT_SUFFIX[variant] : '.jpg';
}

export function isSprayVersionIdentity(identity: SprayVersionIdentity): boolean {
  if (typeof identity === 'number') return Number.isSafeInteger(identity) && identity > 0;
  const match = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([1-9]\d*)$/i.exec(identity);
  return match != null && Number.isSafeInteger(Number(match[1]));
}

/**
 * `spray/<layoutId>/v<versionId>.jpg` for the photo, and
 * `spray/<layoutId>/v<versionId>-crop.jpg` / `-cutout.webp` for a generated look.
 */
export function sprayBackgroundKey(
  layoutId: number,
  versionId: SprayVersionIdentity,
  variant?: SprayArtVariant,
): string {
  return `${SPRAY_BACKGROUND_KEY_PREFIX}${layoutId}/v${versionId}${variantSuffix(variant)}`;
}

/** Parse a key `sprayBackgroundKey` wrote, or `null` when it is not one. */
export function parseSprayBackgroundKey(backgroundImageKey: string): SprayPhotoIdentity | null {
  const match =
    /^spray\/(\d+)\/v(\d+|local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9]\d*)(\.jpg|-crop\.jpg|-cutout\.webp)$/i.exec(
      backgroundImageKey,
    );
  if (!match) return null;
  const versionId = match[2].startsWith('local-') ? (match[2] as SprayVersionIdentity) : Number(match[2]);
  if (!isSprayVersionIdentity(versionId)) return null;
  const suffix = match[3].toLowerCase();
  // Generated looks only exist for a server version: a local mirror has no art.
  if (suffix === '.jpg') return { layoutId: Number(match[1]), versionId };
  if (typeof versionId !== 'number') return null;
  return { layoutId: Number(match[1]), versionId, variant: suffix === '-crop.jpg' ? 'crop' : 'cutout' };
}

/**
 * The filename a wall version's photo is stored under. Also what the sweeper
 * matches on, which is why the version is in it: two generations of one wall are
 * two different photographs and must never share a file.
 */
export function sprayPhotoFileName(identity: SprayPhotoIdentity): string {
  return `${identity.layoutId}-v${identity.versionId}${variantSuffix(identity.variant)}`;
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

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Which stored size of a photo an object key names (`docs/spray-walls.md`, "Two sizes per photo"). */
export type SprayPhotoObjectSize = 'base' | 'full';

/** A private-bucket wall photo, named by the object it is stored as. */
export type SprayPhotoObject = {
  /** `spray-walls/<wallUuid>/<photoId>.jpg`, or `<photoId>-full.jpg` for the full copy. */
  key: string;
  photoId: string;
  size: SprayPhotoObjectSize;
};

/**
 * The private-bucket object a presigned photo URL reads, or `null` when the URL
 * does not name one of `wallUuid`'s photos.
 *
 * The object key is the photo's immutable identity: the upload handler mints a
 * fresh random `photoId` for every upload and never writes to a key twice, and a
 * hold edit reuses its source version's key because it reuses the picture. The
 * URL around the key is not: every read signs it again, and the signature dies
 * fifteen minutes later. So a file named after the key is the same picture
 * whichever signature fetched it.
 *
 * Read off the URL rather than asked of the server because the render payload
 * selects only the signed URL, and the documents it travels in are pinned by the
 * App Store screenshot fixtures. A SigV4 presign, path-style or virtual-hosted,
 * always ends its path in the key (hex, hyphens and `.jpg` need no escaping). A
 * URL that does not parse answers `null`, which every caller treats as "no
 * shared copy" and falls back to its own download, so a different URL shape can
 * cost bytes but never draw the wrong picture: the wall uuid has to match, and
 * the photo id is random.
 */
export function sprayPhotoObjectFromUrl(url: string, wallUuid: string): SprayPhotoObject | null {
  const pathEnd = url.search(/[?#]/);
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  const match = new RegExp(`(?:^|/)spray-walls/(${UUID_PATTERN})/(${UUID_PATTERN})(-full)?\\.jpg$`, 'i').exec(path);
  if (!match || match[1].toLowerCase() !== wallUuid.toLowerCase()) return null;
  const size: SprayPhotoObjectSize = match[3] ? 'full' : 'base';
  return {
    key: `spray-walls/${match[1]}/${match[2]}${match[3] ?? ''}.jpg`,
    photoId: match[2].toLowerCase(),
    size,
  };
}

/**
 * The renderer-cache name for a photo's full-resolution copy:
 * `<layoutId>-full-<photoId>.jpg`.
 *
 * Named after the PHOTO, not the version, unlike the base's
 * `<layoutId>-v<versionId>.jpg`: every hold edit reuses its source's photo, so a
 * version-named copy would fetch the same 4096 px file again for each draft the
 * hold editor opens. The layout id leads so per-wall withdrawal
 * (`deleteCachedSprayPhotos`) finds it with the wall's other files.
 */
export function sprayFullPhotoFileName(layoutId: number, photoId: string): string {
  return `${layoutId}-full-${photoId.toLowerCase()}.jpg`;
}
