/** Images and recordings together may fill one bug report. */
export const FEEDBACK_ATTACHMENT_MAX_COUNT = 4;
/** Keep multipart overhead below the public proxy's 100 MB request cap. */
export const FEEDBACK_RECORDING_MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
export const FEEDBACK_RECORDING_PREFIX = 'feedback-recordings';
export const FEEDBACK_RECORDING_EXTENSIONS = ['mp4', 'mov', 'webm'] as const;
export const FEEDBACK_RECORDING_KEY_PATTERN =
  /^feedback-recordings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|mov|webm)$/;
export function isFeedbackRecordingKey(key: string): boolean {
  return FEEDBACK_RECORDING_KEY_PATTERN.test(key);
}
