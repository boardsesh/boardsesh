import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(),
  set: vi.fn<(key: string, value: unknown) => Promise<void>>(),
}));

vi.mock('../preference-store', () => ({
  getPreference: store.get,
  setPreference: store.set,
  removePreference: vi.fn(),
}));

import { hasUsedResetZoom, markResetZoomUsed } from '../reset-zoom-hint';

describe('reset-zoom hint marker', () => {
  beforeEach(() => {
    store.get.mockReset();
    store.set.mockReset();
    vi.unstubAllEnvs();
  });

  it('treats a fresh device as never having used the control', async () => {
    store.get.mockResolvedValue(null);
    expect(await hasUsedResetZoom()).toBe(false);
  });

  it('reads a store failure as already used', async () => {
    // The fail-safe direction matters: the hint covers holds, so a flaky store
    // must not bring it back on every zoom. Better a missing hint than a
    // permanent one.
    store.get.mockRejectedValue(new Error('store unavailable'));
    expect(await hasUsedResetZoom()).toBe(true);
  });

  it('reports used only for an exact true', async () => {
    store.get.mockResolvedValue('true');
    expect(await hasUsedResetZoom()).toBe(false);
  });

  it('suppresses the hint in screenshot mode', async () => {
    // A captured board must never carry the extended pill across it.
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(await hasUsedResetZoom()).toBe(true);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('writes the marker under a stable key', async () => {
    await markResetZoomUsed();
    expect(store.set).toHaveBeenCalledWith('resetZoomHintUsed', true);
  });
});
