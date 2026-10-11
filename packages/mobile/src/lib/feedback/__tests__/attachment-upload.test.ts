import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import type { FeedbackAttachment } from '../shared-bug-draft.types';

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  size: vi.fn(),
  fetch: vi.fn(),
  compress: vi.fn(),
  screenshot: vi.fn(),
  getSize: vi.fn(),
}));
vi.mock('react-native', () => ({ Image: { getSize: mocks.getSize } }));
vi.mock('../../env', () => ({ BACKEND_URL: 'https://ws.example.com' }));
vi.mock('../../upload-image', () => ({ appendUploadImage: mocks.append, getUploadFileSize: mocks.size }));
vi.mock('../../auth-interceptor', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../../image-compression', () => ({ compressPickedImage: mocks.compress }));
vi.mock('../screenshot-upload', () => ({ uploadFeedbackScreenshot: mocks.screenshot }));

import { uploadFeedbackAttachments, uploadFeedbackRecording } from '../attachment-upload';

function recording(name = 'recording.mov'): FeedbackAttachment {
  return { id: name, kind: 'video', uri: `file:///${name}`, name, mimeType: 'video/quicktime', size: 100 };
}
const image: FeedbackAttachment = {
  id: 'image',
  kind: 'image',
  uri: 'file:///image.png',
  name: 'image.png',
  mimeType: 'image/png',
  size: 100,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.size.mockResolvedValue(100);
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, key: 'feedback-recordings/movie.mov' }),
  });
  mocks.compress.mockResolvedValue('file:///compressed.jpg');
  mocks.screenshot.mockResolvedValue('feedback-screenshots/image.jpg');
  mocks.getSize.mockImplementation((_uri, success: (width: number, height: number) => void) => success(2000, 3000));
});

describe('feedback media uploads', () => {
  it('keeps recording bytes and container when posting to the authenticated endpoint', async () => {
    await expect(uploadFeedbackRecording(recording())).resolves.toBe('feedback-recordings/movie.mov');
    expect(mocks.append).toHaveBeenCalledWith(expect.any(FormData), 'recording', {
      uri: 'file:///recording.mov',
      name: 'recording.mov',
      type: 'video/quicktime',
    });
    expect(mocks.fetch).toHaveBeenCalledWith('https://ws.example.com/api/feedback-recordings', {
      method: 'POST',
      body: expect.any(FormData),
    });
  });

  it('uses a safe multipart filename while retaining the original name for display', async () => {
    const attachment = recording('screen"\r\nrecording.mov');
    await uploadFeedbackRecording(attachment);
    expect(mocks.append).toHaveBeenCalledWith(expect.any(FormData), 'recording', {
      uri: attachment.uri,
      name: 'recording.mov',
      type: 'video/quicktime',
    });
    expect(attachment.name).toBe('screen"\r\nrecording.mov');
  });

  it('checks the actual local recording size and blocks empty or oversized files before requesting', async () => {
    mocks.size.mockResolvedValueOnce(0).mockResolvedValueOnce(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1);
    await expect(uploadFeedbackRecording(recording())).rejects.toThrow('empty');
    await expect(uploadFeedbackRecording(recording())).rejects.toThrow('95 MiB');
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.size.mockResolvedValue(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES);
    await expect(uploadFeedbackRecording(recording())).resolves.toBe('feedback-recordings/movie.mov');
  });

  it('rejects unsupported containers and missing upload keys', async () => {
    await expect(uploadFeedbackRecording({ ...recording(), mimeType: 'video/avi' })).rejects.toThrow('Unsupported');
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await expect(uploadFeedbackRecording(recording())).rejects.toThrow('Recording upload failed');
  });

  it('reads missing dimensions and compresses screenshots to the existing 1600px JPEG path', async () => {
    const remember = vi.fn();
    await expect(uploadFeedbackAttachments([image], {}, remember)).resolves.toEqual({
      screenshotKeys: ['feedback-screenshots/image.jpg'],
      recordingKeys: [],
    });
    expect(mocks.compress).toHaveBeenCalledWith(image.uri, 2000, 3000, { maxDimension: 1600, quality: 0.8 });
    expect(remember).toHaveBeenCalledWith(image.uri, 'feedback-screenshots/image.jpg');
  });

  it('persists each completed upload before starting the next and retries only missing attachments', async () => {
    const cached: Record<string, string> = {};
    const remember = vi.fn(async (uri: string, key: string) => {
      cached[uri] = key;
    });
    mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Network interrupted' }) });
    await expect(uploadFeedbackAttachments([image, recording()], cached, remember)).rejects.toThrow(
      'Network interrupted',
    );
    expect(cached).toEqual({ [image.uri]: 'feedback-screenshots/image.jpg' });
    expect(mocks.screenshot).toHaveBeenCalledTimes(1);
    await expect(uploadFeedbackAttachments([image, recording()], cached, remember)).resolves.toEqual({
      screenshotKeys: ['feedback-screenshots/image.jpg'],
      recordingKeys: ['feedback-recordings/movie.mov'],
    });
    expect(mocks.screenshot).toHaveBeenCalledTimes(1);
  });

  it('does not start the next recording until persistence of the first completes', async () => {
    let finishPersistence: () => void = () => {};
    const remember = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPersistence = resolve;
        }),
    );
    const uploading = uploadFeedbackAttachments([recording('first.mov'), recording('second.mov')], {}, remember);
    await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(1));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    finishPersistence();
    await uploading;
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
