import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to test the functions in isolation, so we re-import after each
// navigator/window mock change. Use dynamic import to avoid caching issues.
async function loadUtils() {
  // Clear module cache so each import picks up current window/navigator state
  vi.resetModules();
  return import('../capacitor-utils');
}

describe('isCapacitorWebView', () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      writable: true,
      configurable: true,
    });
  });

  function setUserAgent(ua: string) {
    Object.defineProperty(navigator, 'userAgent', {
      value: ua,
      writable: true,
      configurable: true,
    });
  }

  it('returns true for Android WebView user agent', async () => {
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(true);
  });

  it('returns false for regular Android Chrome', async () => {
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(false);
  });

  it('returns true for iOS WKWebView (no Safari token)', async () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(true);
  });

  it('returns false for iOS Safari', async () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(false);
  });

  it('returns false for iOS Chrome (includes Safari token)', async () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/127.0.6533.107 Mobile/15E148 Safari/604.1',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(false);
  });

  it('returns false for desktop Chrome', async () => {
    setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    );
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(false);
  });

  it('returns false for empty user agent', async () => {
    setUserAgent('');
    const { isCapacitorWebView } = await loadUtils();
    expect(isCapacitorWebView()).toBe(false);
  });
});

describe('waitForCapacitor', () => {
  const originalCapacitor = window.Capacitor;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCapacitor === undefined) {
      delete (window as unknown as Record<string, unknown>).Capacitor;
    } else {
      window.Capacitor = originalCapacitor;
    }
  });

  it('resolves true immediately if Capacitor is already present', async () => {
    Object.defineProperty(window, 'Capacitor', {
      value: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} },
      writable: true,
      configurable: true,
    });
    const { waitForCapacitor } = await loadUtils();
    const result = await waitForCapacitor(1000);
    expect(result).toBe(true);
  });

  it('resolves true when Capacitor appears during polling', async () => {
    delete (window as unknown as Record<string, unknown>).Capacitor;
    const { waitForCapacitor } = await loadUtils();

    const promise = waitForCapacitor(2000, 100);

    // Simulate Capacitor bridge injection after 300ms
    vi.advanceTimersByTime(200);
    Object.defineProperty(window, 'Capacitor', {
      value: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} },
      writable: true,
      configurable: true,
    });
    vi.advanceTimersByTime(100);

    const result = await promise;
    expect(result).toBe(true);
  });

  it('resolves false after timeout if Capacitor never appears', async () => {
    delete (window as unknown as Record<string, unknown>).Capacitor;
    const { waitForCapacitor } = await loadUtils();

    const promise = waitForCapacitor(500, 100);
    vi.advanceTimersByTime(600);

    const result = await promise;
    expect(result).toBe(false);
  });
});

describe('isCapacitor', () => {
  const originalCapacitor = window.Capacitor;

  afterEach(() => {
    if (originalCapacitor === undefined) {
      delete (window as unknown as Record<string, unknown>).Capacitor;
    } else {
      window.Capacitor = originalCapacitor;
    }
  });

  it('returns true when window.Capacitor is defined', async () => {
    Object.defineProperty(window, 'Capacitor', {
      value: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} },
      writable: true,
      configurable: true,
    });
    const { isCapacitor } = await loadUtils();
    expect(isCapacitor()).toBe(true);
  });

  it('returns false when window.Capacitor is undefined', async () => {
    delete (window as unknown as Record<string, unknown>).Capacitor;
    const { isCapacitor } = await loadUtils();
    expect(isCapacitor()).toBe(false);
  });
});
