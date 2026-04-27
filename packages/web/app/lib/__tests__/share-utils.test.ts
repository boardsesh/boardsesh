import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { shareWithFallback } from '../share-utils';

// Mock @/app/lib/analytics
vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

const baseOptions = {
  url: 'https://boardsesh.com/test',
  title: 'Test Share',
  text: 'Check this out',
  trackingEvent: 'Test Shared',
  trackingProps: { source: 'unit-test' },
};

describe('shareWithFallback', () => {
  let originalNavigator: Navigator;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  function mockNavigator(overrides: Partial<Navigator>) {
    Object.defineProperty(globalThis, 'navigator', {
      value: Object.assign(Object.create(Object.getPrototypeOf(originalNavigator)), originalNavigator, overrides),
      configurable: true,
      writable: true,
    });
  }

  describe('native share path', () => {
    it('uses navigator.share when available and canShare returns true', async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      const canShare = vi.fn().mockReturnValue(true);
      mockNavigator({ share, canShare } as unknown as Partial<Navigator>);

      const result = await shareWithFallback(baseOptions);

      expect(result).toBe(true);
      expect(share).toHaveBeenCalledWith({
        title: baseOptions.title,
        text: baseOptions.text,
        url: baseOptions.url,
      });
    });

    it('returns false when native share is cancelled (AbortError)', async () => {
      const abortError = new DOMException('Share cancelled', 'AbortError');
      const share = vi.fn().mockRejectedValue(abortError);
      const canShare = vi.fn().mockReturnValue(true);
      mockNavigator({ share, canShare } as unknown as Partial<Navigator>);

      const onError = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onError });

      expect(result).toBe(false);
      expect(onError).not.toHaveBeenCalled();
    });

    it('falls back to clipboard when native share fails with non-AbortError', async () => {
      const share = vi.fn().mockRejectedValue(new Error('Share failed'));
      const canShare = vi.fn().mockReturnValue(true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share,
        canShare,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      const onClipboardSuccess = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onClipboardSuccess });

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(baseOptions.url);
      expect(onClipboardSuccess).toHaveBeenCalled();
    });
  });

  describe('clipboard fallback path', () => {
    it('copies to clipboard when navigator.share is unavailable', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share: undefined,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      const onClipboardSuccess = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onClipboardSuccess });

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(baseOptions.url);
      expect(onClipboardSuccess).toHaveBeenCalled();
    });

    it('copies to clipboard when canShare returns false', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share: vi.fn(),
        canShare: vi.fn().mockReturnValue(false),
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      const onClipboardSuccess = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onClipboardSuccess });

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(baseOptions.url);
    });

    it('copies to clipboard when canShare is undefined', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share: vi.fn(),
        canShare: undefined,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      const onClipboardSuccess = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onClipboardSuccess });

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith(baseOptions.url);
    });
  });

  describe('error handling', () => {
    it('calls onError when both share and clipboard fail', async () => {
      const share = vi.fn().mockRejectedValue(new Error('Share failed'));
      const canShare = vi.fn().mockReturnValue(true);
      const writeText = vi.fn().mockRejectedValue(new Error('Clipboard failed'));
      mockNavigator({
        share,
        canShare,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      const onError = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onError });

      expect(result).toBe(false);
      expect(onError).toHaveBeenCalled();
    });

    it('returns false without calling onError when AbortError and clipboard not attempted', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      const share = vi.fn().mockRejectedValue(abortError);
      const canShare = vi.fn().mockReturnValue(true);
      mockNavigator({ share, canShare } as unknown as Partial<Navigator>);

      const onError = vi.fn();
      const onClipboardSuccess = vi.fn();
      const result = await shareWithFallback({ ...baseOptions, onError, onClipboardSuccess });

      expect(result).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(onClipboardSuccess).not.toHaveBeenCalled();
    });
  });

  describe('analytics tracking', () => {
    it('tracks native share method', async () => {
      const { track } = await import('@/app/lib/analytics');
      const share = vi.fn().mockResolvedValue(undefined);
      const canShare = vi.fn().mockReturnValue(true);
      mockNavigator({ share, canShare } as unknown as Partial<Navigator>);

      await shareWithFallback(baseOptions);

      expect(track).toHaveBeenCalledWith('Test Shared', {
        source: 'unit-test',
        method: 'native',
      });
    });

    it('tracks clipboard method on error-path fallback', async () => {
      const { track } = await import('@/app/lib/analytics');
      const share = vi.fn().mockRejectedValue(new Error('Share failed'));
      const canShare = vi.fn().mockReturnValue(true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share,
        canShare,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      await shareWithFallback(baseOptions);

      expect(track).toHaveBeenCalledWith('Test Shared', {
        source: 'unit-test',
        method: 'clipboard',
      });
    });

    it('tracks clipboard method', async () => {
      const { track } = await import('@/app/lib/analytics');
      const writeText = vi.fn().mockResolvedValue(undefined);
      mockNavigator({
        share: undefined,
        clipboard: { writeText } as unknown as Clipboard,
      } as unknown as Partial<Navigator>);

      await shareWithFallback(baseOptions);

      expect(track).toHaveBeenCalledWith('Test Shared', {
        source: 'unit-test',
        method: 'clipboard',
      });
    });
  });
});
