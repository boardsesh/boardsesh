import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { buildStoreUrl } from '@/app/lib/store-links';

/**
 * #6027: every help sub-page ends with a store button. Before it only the /help
 * index had one, so a reader who landed on a sub-page from a search had no way
 * to a store from the page that had just explained the app to them.
 */

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => false,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// Screenshots and clips are the bulk of each page and none of this test.
vi.mock('../help-screenshot', () => ({
  HelpScreenshot: () => null,
  HelpShots: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../help-clip', () => ({
  HelpClip: () => null,
  HelpShots: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// Imported up front, so a slow module load is not charged to a test's timeout.
const SUB_PAGES = [
  ['beta-videos', (await import('../beta-videos/beta-videos-content')).default],
  ['board-and-bluetooth', (await import('../board-and-bluetooth/board-and-bluetooth-content')).default],
  ['climb-actions', (await import('../climb-actions/climb-actions-content')).default],
  ['finding-climbs', (await import('../finding-climbs/finding-climbs-content')).default],
  ['logbook', (await import('../logbook/logbook-content')).default],
  ['playlists', (await import('../playlists/playlists-content')).default],
  ['sessions', (await import('../sessions/sessions-content')).default],
] as const;

const ORIGINAL_UA = navigator.userAgent;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

describe('help sub-page store button', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: ANDROID_UA, configurable: true });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'userAgent', { value: ORIGINAL_UA, configurable: true });
  });

  it('covers all seven sub-pages', () => {
    expect(SUB_PAGES).toHaveLength(7);
  });

  it.each(SUB_PAGES)('/help/%s ends with a store button carrying the help link id', async (_slug, Content) => {
    render(<Content />);

    const playLink = await screen.findByRole('link', { name: 'home.hero.ctaInstallAndroid' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'help' }));
    expect(screen.getByRole('heading', { name: 'help.install.title' })).toBeTruthy();
    expect(screen.getByText('help.install.intro')).toBeTruthy();
  });
});
