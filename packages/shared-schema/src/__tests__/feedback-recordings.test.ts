import { describe, expect, it } from 'vite-plus/test';
import {
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_RECORDING_MAX_UPLOAD_BYTES,
  isFeedbackRecordingKey,
} from '../feedback-recordings';

describe('feedback recording attachment contract', () => {
  it.each(['mp4', 'mov', 'webm'])('accepts minted %s keys', (extension) => {
    expect(isFeedbackRecordingKey(`feedback-recordings/11111111-2222-4333-8444-555555555555.${extension}`)).toBe(true);
  });
  it.each([
    'feedback-recordings/../../private.mov',
    'feedback-recordings/not-uuid.mp4',
    'feedback-recordings/11111111-2222-4333-8444-555555555555.mp4?x=y',
    'feedback-screenshots/11111111-2222-4333-8444-555555555555.mp4',
  ])('rejects unsafe keys %s', (key) => {
    expect(isFeedbackRecordingKey(key)).toBe(false);
  });
  it('keeps recording bytes plus multipart overhead under the 100 MB proxy limit', () => {
    expect(FEEDBACK_ATTACHMENT_MAX_COUNT).toBe(4);
    expect(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 100_000).toBeLessThan(100_000_000);
  });
});
