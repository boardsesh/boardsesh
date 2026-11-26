import { STATIC_ASSET_ORIGIN } from '@boardsesh/static-assets';

/** A missing build file may redirect only to the retained public namespace. */
export function getRetainedNextAssetUrl(assetPath: readonly string[]): URL | null {
  if (assetPath.length === 0 || assetPath.length > 64) return null;
  if (assetPath.some(isUnsafeAssetSegment)) return null;
  // Source maps are deliberately excluded by the immutable-asset publisher.
  if (/\.map$/iu.test(assetPath.at(-1) ?? '')) return null;
  const pathname = '/_next/static/' + assetPath.map(encodeURIComponent).join('/');
  if (pathname.length > 2048) return null;
  return new URL(pathname, STATIC_ASSET_ORIGIN);
}

function isUnsafeAssetSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 2048 || segment === '.' || segment === '..') return true;
  if (/[\\/%]/u.test(segment)) return true;
  for (const character of segment) {
    const characterCode = character.charCodeAt(0);
    if (characterCode < 32 || characterCode === 127) return true;
  }
  return false;
}
