import { Image } from 'react-native';
import { FEEDBACK_ATTACHMENT_MAX_COUNT, FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { appendUploadImage, getUploadFileSize } from '../upload-image';
import { authenticatedFetch } from '../auth-interceptor';
import { BACKEND_URL } from '../env';
import { compressPickedImage } from '../image-compression';
import { uploadFeedbackScreenshot } from './screenshot-upload';
import type { FeedbackAttachment } from './shared-bug-draft.types';

export const FEEDBACK_RECORDING_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

export function isSupportedFeedbackRecording(mimeType: string): boolean {
  return FEEDBACK_RECORDING_MIME_TYPES.some((supportedType) => supportedType === mimeType);
}

export async function uploadFeedbackRecording(attachment: FeedbackAttachment): Promise<string> {
  if (!isSupportedFeedbackRecording(attachment.mimeType)) throw new Error('Unsupported recording format');
  const fileSize = await getUploadFileSize(attachment.uri);
  if (fileSize <= 0) throw new Error('Selected recording is empty');
  if (fileSize > FEEDBACK_RECORDING_MAX_UPLOAD_BYTES) throw new Error('Recording exceeds 95 MiB');
  const formData = new FormData();
  const extension =
    attachment.mimeType === 'video/quicktime' ? 'mov' : attachment.mimeType === 'video/webm' ? 'webm' : 'mp4';
  await appendUploadImage(formData, 'recording', {
    uri: attachment.uri,
    name: `recording.${extension}`,
    type: attachment.mimeType,
  });
  const response = await authenticatedFetch(`${BACKEND_URL}/api/feedback-recordings`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? 'Recording upload failed');
  }
  const result = (await response.json()) as { key?: string };
  if (!result.key) throw new Error('Recording upload failed');
  return result.key;
}

async function uploadImageAttachment(attachment: FeedbackAttachment): Promise<string> {
  let width = attachment.width ?? 0;
  let height = attachment.height ?? 0;
  if (width <= 0 || height <= 0) {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(
        attachment.uri,
        (imageWidth, imageHeight) => resolve({ width: imageWidth, height: imageHeight }),
        reject,
      );
    });
    width = dimensions.width;
    height = dimensions.height;
  }
  const compressedUri = await compressPickedImage(attachment.uri, width, height, { maxDimension: 1600, quality: 0.8 });
  return uploadFeedbackScreenshot(compressedUri);
}

/** Upload one at a time so recordings never compete for memory or bandwidth.
 * Cache entries use the original durable URI, including images re-encoded for upload.
 * Persist each successful key before starting the next request; a failure retains it.
 */
export async function uploadFeedbackAttachments(
  attachments: readonly FeedbackAttachment[],
  cachedKeys: Readonly<Record<string, string>>,
  rememberUploadedKey: (uri: string, key: string) => void | Promise<void>,
): Promise<{ screenshotKeys: string[]; recordingKeys: string[] }> {
  if (attachments.length > FEEDBACK_ATTACHMENT_MAX_COUNT) throw new Error('Too many feedback attachments');
  const screenshotKeys: string[] = [];
  const recordingKeys: string[] = [];
  const workingKeys = { ...cachedKeys };
  for (const attachment of attachments) {
    const key =
      workingKeys[attachment.uri] ??
      (attachment.kind === 'video'
        ? await uploadFeedbackRecording(attachment)
        : await uploadImageAttachment(attachment));
    if (!workingKeys[attachment.uri]) {
      await rememberUploadedKey(attachment.uri, key);
      workingKeys[attachment.uri] = key;
    }
    if (attachment.kind === 'video') recordingKeys.push(key);
    else screenshotKeys.push(key);
  }
  return { screenshotKeys, recordingKeys };
}
