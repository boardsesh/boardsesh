// Maps the backend's `/static/*` routes onto public media-bucket URLs.
//
// Pure and side-effect free so the mapping can be tested without a server —
// `handlers/static.ts` has no tests of its own, and this is the part where a
// mistake either 404s every avatar or, worse, lets a crafted path escape its
// prefix.
//
// Why a redirect rather than just changing the stored URLs: the persisted
// values in `user_profiles.avatar_url`, `gyms.image_url` and `gyms.logo_url`
// are backend-relative `/static/…?v=` paths, and released mobile builds
// string-match `/static/avatars/` before appending `?size=` (see
// packages/mobile/src/components/Avatar.tsx). Rewriting those columns to
// absolute URLs would make every shipped client fetch the full-res original
// for a 40px circle. A 301 keeps those clients correct while taking the byte
// path off the backend: one permanently-cached redirect, then the CDN.

import { ALLOWED_IMAGE_SIZES, type AllowedImageSize } from '@boardsesh/shared-schema';

/** Object-key prefixes reachable through `/static/<segment>/`. */
const SIMPLE_STATIC_ROUTES: Readonly<Record<string, string>> = {
  avatars: 'avatars',
  'gym-logos': 'gym-logos',
  'gym-photos': 'gym-photos',
};

// `feedback-screenshots` is deliberately absent. Everything mapped here folds
// `?size=` into a `@<size>.jpg` variant key, and screenshots have no variants —
// a sized request would redirect to an object that was never written. Their
// route does its own redirect in handlers/static.ts, which ignores `?size=`.

/** Mirrors the validation in handlers/static.ts — kept identical on purpose. */
const SIMPLE_FILENAME = /^[A-Za-z0-9._-]+$/;
const BETA_THUMBNAIL_PLATFORMS = new Set(['instagram', 'tiktok']);
const BETA_THUMBNAIL_FILENAME = /^[A-Za-z0-9_-]+\.jpg$/;

/** The query parameter carrying the per-version cache buster. */
export const VERSION_QUERY_PARAM = 'v';

/**
 * Key of the resized variant of an object, or the base key when `size` is null.
 *
 * Deliberately the same shape as `resizedVariantKey` in `lib/image-resize.ts`
 * (`<baseKey>@<size>.jpg`) so a variant written by the resize path and a URL
 * built here address the same object. Changing one without the other silently
 * 404s every sized request.
 */
export function mediaVariantKey(baseKey: string, size: AllowedImageSize | null): string {
  return size === null ? baseKey : `${baseKey}@${size}.jpg`;
}

/**
 * Absolute URL for a media object.
 *
 * `version` is passed through as `?v=` rather than baked into the key: the
 * object store ignores unknown query parameters, so it gives per-version URL
 * immutability for the mutable keys (avatars, gym images are overwritten in
 * place) without a versioned key layout to garbage-collect.
 */
export function buildMediaObjectUrl(
  baseUrl: string,
  key: string,
  size: AllowedImageSize | null = null,
  version?: string | null,
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBase}/${mediaVariantKey(key, size)}`;
  return version ? `${url}?${VERSION_QUERY_PARAM}=${encodeURIComponent(version)}` : url;
}

function parseSize(raw: string | null): AllowedImageSize | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return (ALLOWED_IMAGE_SIZES as readonly number[]).includes(parsed) ? (parsed as AllowedImageSize) : null;
}

/**
 * Translate a `/static/…` request into the media-bucket URL it should redirect
 * to, or null when the path is not one this maps (caller falls through to the
 * existing proxy behaviour).
 *
 * Returning null rather than throwing keeps the caller's shape simple: a path
 * this does not recognise is served exactly as it is today.
 *
 * `?size=` is folded into the object key because a bucket has no resizer; an
 * off-allowlist value is dropped rather than honoured, matching
 * `parseSizeParam`, so a request for a size we never generated resolves to the
 * base object instead of a guaranteed 404.
 */
export function staticPathToMediaRedirect(pathname: string, search: URLSearchParams, baseUrl: string): string | null {
  if (!pathname.startsWith('/static/')) return null;

  const segments = pathname.slice('/static/'.length).split('/');
  const size = parseSize(search.get('size'));
  const version = search.get(VERSION_QUERY_PARAM);

  // `/static/beta-link-thumbnails/<platform>/<file>`
  if (segments[0] === 'beta-link-thumbnails') {
    const [, platform, fileName, ...rest] = segments;
    if (rest.length > 0 || !platform || !fileName) return null;
    if (!BETA_THUMBNAIL_PLATFORMS.has(platform) || !BETA_THUMBNAIL_FILENAME.test(fileName)) return null;
    return buildMediaObjectUrl(baseUrl, `beta-link-thumbnails/${platform}/${fileName}`, size, version);
  }

  // `/static/<avatars|gym-logos|gym-photos>/<file>`
  const [routeSegment, fileName, ...rest] = segments;
  const prefix = routeSegment ? SIMPLE_STATIC_ROUTES[routeSegment] : undefined;
  if (!prefix || rest.length > 0 || !fileName) return null;
  // Rejects `..`, empty names and anything with a path separator, which is the
  // same guard the proxying handlers apply via `path.basename`.
  if (!SIMPLE_FILENAME.test(fileName) || fileName === '.' || fileName === '..') return null;

  return buildMediaObjectUrl(baseUrl, `${prefix}/${fileName}`, size, version);
}
