// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  share: vi.fn(async (): Promise<{ action: string } | void> => ({ action: 'sharedAction' })),
  setStringAsync: vi.fn(async () => true),
}));
vi.mock('react-native', () => ({
  Platform: mocks.platform,
  Share: { share: mocks.share, dismissedAction: 'dismissedAction' },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setStringAsync }));

import { shareLink } from '../share-link';

const url = 'https://www.boardsesh.com/b/garage?invite=Ab3_dE-fGhIjKlMnOpQrSt';

beforeEach(() => {
  mocks.platform.OS = 'ios';
  mocks.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  mocks.setStringAsync.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
});

describe('shareLink', () => {
  it('keeps a tokened URL unchanged and includes it once in Android messages', async () => {
    mocks.platform.OS = 'android';
    expect(await shareLink({ url, message: url })).toBe('shared');
    expect(mocks.share).toHaveBeenCalledWith({ message: url });
  });

  it('recognizes a dismissed native share sheet', async () => {
    mocks.share.mockResolvedValue({ action: 'dismissedAction' });
    expect(await shareLink({ url, message: 'Garage' })).toBe('cancelled');
    expect(mocks.setStringAsync).not.toHaveBeenCalled();
  });

  it('accepts the browser share API resolving without a result', async () => {
    mocks.platform.OS = 'web';
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() });
    mocks.share.mockResolvedValue(undefined);
    expect(await shareLink({ url, message: 'Garage' })).toBe('shared');
    expect(mocks.setStringAsync).not.toHaveBeenCalled();
  });

  it('never copies after browser cancellation', async () => {
    mocks.platform.OS = 'web';
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() });
    mocks.share.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    expect(await shareLink({ url, message: 'Garage' })).toBe('cancelled');
    expect(mocks.setStringAsync).not.toHaveBeenCalled();
  });

  it('copies after a synchronous browser share failure', async () => {
    mocks.platform.OS = 'web';
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn() });
    mocks.share.mockImplementation(() => {
      throw new Error('Blocked');
    });
    expect(await shareLink({ url, message: 'Garage' })).toBe('copied');
    expect(mocks.setStringAsync).toHaveBeenCalledWith(url);
  });

  it('rejects when fallback copying rejects', async () => {
    mocks.platform.OS = 'web';
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    mocks.setStringAsync.mockRejectedValue(new Error('Clipboard denied'));
    await expect(shareLink({ url, message: 'Garage' })).rejects.toThrow('Clipboard denied');
  });

  it('rejects genuine native errors for callers to report', async () => {
    mocks.share.mockRejectedValue(new Error('Share failed'));
    await expect(shareLink({ url, message: 'Garage' })).rejects.toThrow('Share failed');
  });
});
