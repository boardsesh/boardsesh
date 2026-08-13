import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWakeLock } from '../use-wake-lock';

function createMockWakeLockSentinel(): WakeLockSentinel {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    released: false,
    type: 'screen' as const,
    release: vi.fn(async function (this: WakeLockSentinel) {
      (this as unknown as { released: boolean }).released = true;
      // Trigger release listeners
      listeners['release']?.forEach((fn) => fn());
    }),
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((fn) => fn !== handler);
      }
    }),
    dispatchEvent: vi.fn(() => true),
    onrelease: null,
  };
}

describe('useWakeLock', () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequest = vi.fn();

    // Set up navigator.wakeLock
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: mockRequest },
      writable: true,
      configurable: true,
    });

    // Reset document.visibilityState to 'visible'
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isSupported reflects navigator.wakeLock availability', () => {
    const { result } = renderHook(() => useWakeLock(false));
    expect(result.current.isSupported).toBe(true);
  });

  it('isSupported is false when navigator.wakeLock is not available', () => {
    // Remove the property entirely to make 'wakeLock' in navigator return false
    Object.defineProperty(navigator, 'wakeLock', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');

    const { result } = renderHook(() => useWakeLock(false));
    expect(result.current.isSupported).toBe(false);
  });

  it('requests wake lock when enabled and supported', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    const { result } = renderHook(() => useWakeLock(true));

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    expect(mockRequest).toHaveBeenCalledWith('screen');
  });

  it('does not request wake lock when not enabled', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    const { result } = renderHook(() => useWakeLock(false));

    // Wait for effects to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(false);
  });

  it('releases wake lock when disabled after being enabled', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    const { result, rerender } = renderHook(({ enabled }) => useWakeLock(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    // Disable the wake lock
    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.isActive).toBe(false);
    });

    expect(sentinel.release).toHaveBeenCalled(); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
  });

  it('re-acquires wake lock on visibility change when document becomes visible', async () => {
    const sentinel1 = createMockWakeLockSentinel();
    const sentinel2 = createMockWakeLockSentinel();
    mockRequest.mockResolvedValueOnce(sentinel1).mockResolvedValueOnce(sentinel2);

    const { result } = renderHook(() => useWakeLock(true));

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);

    // Simulate visibility change to visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });

  it('does not re-acquire wake lock on visibility change when disabled', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    renderHook(() => useWakeLock(false));

    // Wait for effects
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockRequest).not.toHaveBeenCalled();

    // Simulate visibility change
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Should still not have been called
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('handles request failure gracefully', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRequest.mockRejectedValue(new Error('Document is not visible'));

    const { result } = renderHook(() => useWakeLock(true));

    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith('Wake Lock request failed:', expect.any(Error));
    });

    expect(result.current.isActive).toBe(false);
    consoleWarnSpy.mockRestore();
  });

  it('handles release failure gracefully', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    // Make release fail
    (sentinel.release as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Release failed'));

    const { result, rerender } = renderHook(({ enabled }) => useWakeLock(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    // Disable to trigger release
    rerender({ enabled: false });

    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith('Wake Lock release failed:', expect.any(Error));
    });

    consoleWarnSpy.mockRestore();
  });

  it('cleans up on unmount', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    const { result, unmount } = renderHook(() => useWakeLock(true));

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    unmount();

    // Release should have been called during cleanup
    expect(sentinel.release).toHaveBeenCalled(); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
  });

  it('sets isActive correctly through lifecycle', async () => {
    const sentinel = createMockWakeLockSentinel();
    mockRequest.mockResolvedValue(sentinel);

    const { result, rerender } = renderHook(({ enabled }) => useWakeLock(enabled), {
      initialProps: { enabled: false },
    });

    // Initially not active
    expect(result.current.isActive).toBe(false);

    // Enable
    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.isActive).toBe(true);
    });

    // Disable
    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.isActive).toBe(false);
    });
  });
});
