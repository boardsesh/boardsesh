// @vitest-environment jsdom
//
// The 2.7 preview-first spotlight on What's New. Copy from the en-US catalog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import commonCatalog from '@boardsesh/i18n/locales/en-US/common.json';

type Children = { children?: ReactNode };

// The record, through the real spotlight rules, in memory.
const secure = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async (key: string) => (values.has(key) ? values.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
});
vi.mock('../../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: { get: secure.get, set: secure.set, remove: vi.fn() },
}));
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: ({ light }: { light: string }) => light,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          commonCatalog,
        );
      return typeof found === 'string' ? found : key;
    },
    i18n: { language: 'es', resolvedLanguage: 'es' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, minHeight }: { title: string; onPress: () => void; minHeight?: number }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-min-height': minHeight }, title),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { label: '#111', separator: '#ccc' } }),
}));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: openUrl }));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
const { PreviewFirstSpotlightCard } = await import('../PreviewFirstSpotlightCard');
const copy = commonCatalog.mobile.changelog.previewFirstSpotlight;
const KEY = 'changelog_spotlight_preview_first';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  secure.values.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('PreviewFirstSpotlightCard', () => {
  it('says what changed in 2.7 and starts its 30 days', async () => {
    render(createElement(PreviewFirstSpotlightCard));
    expect((await screen.findByRole('heading')).textContent).toBe(copy.title);
    expect(screen.getByText(copy.tap)).toBeTruthy();
    expect(screen.getByText(copy.swipe)).toBeTruthy();
    expect(screen.getByText(copy.back)).toBeTruthy();
    await waitFor(() => expect(secure.values.get(KEY)).toMatchObject({ dismissed: false }));
    expect(typeof (secure.values.get(KEY) as { shownAt: unknown }).shownAt).toBe('number');
  });

  it("links to the board help's driving section in the app's language", async () => {
    render(createElement(PreviewFirstSpotlightCard));
    fireEvent.click(await screen.findByText(copy.cta));
    expect(openUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/es/help/board-and-bluetooth#driving',
      'whats-new-preview-first',
    );
  });

  it('goes for good on Got it', async () => {
    render(createElement(PreviewFirstSpotlightCard));
    fireEvent.click(await screen.findByText(copy.dismiss));
    expect(screen.queryByRole('heading')).toBeNull();
    await waitFor(() => expect(secure.values.get(KEY)).toMatchObject({ dismissed: true }));
  });

  // A small text button lands at 40 dp on Android without a floor.
  it('gives Got it a full touch target', async () => {
    render(createElement(PreviewFirstSpotlightCard));
    expect((await screen.findByText(copy.dismiss)).dataset.minHeight).toBe('44');
  });

  it('stays away once dismissed', async () => {
    secure.values.set(KEY, { shownAt: null, dismissed: true });
    render(createElement(PreviewFirstSpotlightCard));
    await waitFor(() => expect(secure.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('stays away past its 30 days', async () => {
    secure.values.set(KEY, { shownAt: Date.now() - 31 * DAY, dismissed: false });
    render(createElement(PreviewFirstSpotlightCard));
    await waitFor(() => expect(secure.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('never shows on a captured store screen', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    render(createElement(PreviewFirstSpotlightCard));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secure.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
