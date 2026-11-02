import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    adapter: {
      get: vi.fn(async (key: string) => (values.has(key) ? values.get(key) : null)),
      set: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
});
vi.mock('../preferences/secure-store-adapter', () => ({ secureStorePreferences: store.adapter }));

const {
  PREVIEW_FIRST_SPOTLIGHT_DAYS,
  dismissPreviewFirstSpotlight,
  hasUnseenPreviewFirstSpotlight,
  isPreviewFirstSpotlightActive,
  loadPreviewFirstSpotlight,
  markPreviewFirstSpotlightShown,
} = await import('../preview-first-spotlight');

const KEY = 'changelog_spotlight_preview_first';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12);

beforeEach(() => {
  store.values.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isPreviewFirstSpotlightActive', () => {
  it('stays pinned for 30 days after it first showed, then goes', () => {
    expect(PREVIEW_FIRST_SPOTLIGHT_DAYS).toBe(30);
    expect(isPreviewFirstSpotlightActive({ shownAt: null, dismissed: false }, NOW)).toBe(true);
    expect(isPreviewFirstSpotlightActive({ shownAt: NOW - 29 * DAY, dismissed: false }, NOW)).toBe(true);
    expect(isPreviewFirstSpotlightActive({ shownAt: NOW - 30 * DAY, dismissed: false }, NOW)).toBe(false);
  });

  it('goes for good once dismissed', () => {
    expect(isPreviewFirstSpotlightActive({ shownAt: null, dismissed: true }, NOW)).toBe(false);
  });
});

describe('the spotlight record', () => {
  it('reads never shown on a fresh install, and from a malformed record', async () => {
    expect(await loadPreviewFirstSpotlight()).toEqual({ shownAt: null, dismissed: false });
    store.values.set(KEY, { shownAt: 'yesterday' });
    expect(await loadPreviewFirstSpotlight()).toEqual({ shownAt: null, dismissed: false });
  });

  it('reads a store it cannot read as dismissed, so it never keeps coming back', async () => {
    store.adapter.get.mockRejectedValueOnce(new Error('keychain locked'));
    expect(await loadPreviewFirstSpotlight()).toEqual({ shownAt: null, dismissed: true });
  });

  it('starts the 30 days on the first show and keeps that date after', async () => {
    const first = await markPreviewFirstSpotlightShown({ shownAt: null, dismissed: false }, NOW);
    expect(first).toEqual({ shownAt: NOW, dismissed: false });
    await markPreviewFirstSpotlightShown(first, NOW + 5 * DAY);

    expect(store.adapter.set).toHaveBeenCalledTimes(1);
    expect(await loadPreviewFirstSpotlight()).toEqual({ shownAt: NOW, dismissed: false });
  });

  it('remembers a dismiss', async () => {
    await dismissPreviewFirstSpotlight({ shownAt: NOW, dismissed: false });
    expect(await loadPreviewFirstSpotlight()).toEqual({ shownAt: NOW, dismissed: true });
  });
});

describe('hasUnseenPreviewFirstSpotlight', () => {
  it('lights the What’s New pill until the card has shown once', async () => {
    expect(await hasUnseenPreviewFirstSpotlight()).toBe(true);
    store.values.set(KEY, { shownAt: NOW, dismissed: false });
    expect(await hasUnseenPreviewFirstSpotlight()).toBe(false);
  });

  it('never lights it once dismissed', async () => {
    store.values.set(KEY, { shownAt: null, dismissed: true });
    expect(await hasUnseenPreviewFirstSpotlight()).toBe(false);
  });

  it('never lights it in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    expect(await hasUnseenPreviewFirstSpotlight()).toBe(false);
  });
});
