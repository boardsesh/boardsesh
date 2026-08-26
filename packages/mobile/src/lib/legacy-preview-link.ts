const LEGACY_PREVIEW_PREFIX = /^(?:https:\/\/(?:www\.)?boardsesh\.com\/?|com\.boardsesh\.app:\/\/\/?)/i;
const LEGACY_PREVIEW_PATH = /^\/preview\/pr-[1-9]\d*(?:[/?#]|$)/;

/** Recognize durable links emitted by Boardsesh's retired OTA picker. */
export function isLegacyPreviewLink(url: string): boolean {
  const normalizedPath = url.replace(LEGACY_PREVIEW_PREFIX, '/');
  return LEGACY_PREVIEW_PATH.test(normalizedPath);
}
