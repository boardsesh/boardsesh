import { FEEDBACK_ATTACHMENT_MAX_COUNT, isFeedbackRecordingKey } from '@boardsesh/shared-schema';
import { getPublicUrl } from '../storage/s3';
import { logger } from '../utils/logger';

let warnedMissingPublicBase = false;
export function recordingPublicUrls(keys: readonly string[] | null | undefined): string[] {
  const minted = keys?.filter(isFeedbackRecordingKey).slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT) ?? [];
  if (!minted.length) return [];
  try {
    return minted.map((key) => getPublicUrl('media', key));
  } catch (error) {
    if (!warnedMissingPublicBase) {
      warnedMissingPublicBase = true;
      logger.warn('[feedback-recordings] no public media URL; recordings remain stored:', error);
    }
    return [];
  }
}
export function recordingMarkdownSection(urls: readonly string[]): string[] {
  return urls.length ? ['', '## Recordings', '', ...urls.map((url, index) => `[Recording ${index + 1}](${url})`)] : [];
}
