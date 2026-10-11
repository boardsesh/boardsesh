import type { ShareIntent } from 'expo-share-intent';

/** Prefer the structured URL, then the first URL in a caption. */
export function extractSharedLink(shareIntent: Pick<ShareIntent, 'webUrl' | 'text'> | null): string | null {
  if (!shareIntent) return null;
  const webUrl = shareIntent.webUrl?.trim();
  if (webUrl) return webUrl;
  const match = shareIntent.text?.match(/https?:\/\/[^\s)\]}>"'«»]+/u);
  if (!match) return null;
  const trimmed = match[0].replace(/[\s\p{S}.,;:!?…]+$/u, '');
  return trimmed.length > 0 ? trimmed : null;
}
