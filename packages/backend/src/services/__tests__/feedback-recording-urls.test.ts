import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const publicUrl = vi.hoisted(() => vi.fn((bucket: string, key: string) => `https://${bucket}.boardsesh.com/${key}`));
vi.mock('../../storage/s3', () => ({ getPublicUrl: publicUrl }));
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn() } }));
import { recordingPublicUrls } from '../feedback-recording-urls';
const key = 'feedback-recordings/11111111-2222-4333-8444-555555555555.mp4';
beforeEach(() => {
  vi.clearAllMocks();
});
describe('public recording URL trust boundary', () => {
  it('drops unsafe keys before they can become public links', () => {
    expect(recordingPublicUrls(['feedback-recordings/../../private.mov', key])).toEqual([
      `https://media.boardsesh.com/${key}`,
    ]);
    expect(publicUrl).toHaveBeenCalledTimes(1);
  });
  it('clips older or future database writers to four recording URLs', () => {
    expect(recordingPublicUrls(Array(9).fill(key) as string[])).toHaveLength(4);
  });
  it('keeps the report readable when the public storage URL is unavailable', () => {
    publicUrl.mockImplementationOnce(() => {
      throw new Error('No media public base');
    });
    expect(recordingPublicUrls([key])).toEqual([]);
    expect(recordingPublicUrls(null)).toEqual([]);
  });
});
