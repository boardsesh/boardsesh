import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CapacitorRetirementScreen } from '../capacitor-retirement-screen';
import { getPlatform } from '@/app/lib/ble/capacitor-utils';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { track } from '@/app/lib/analytics-capture';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// store-urls is left real so the test asserts the actual store URLs the CTAs open.
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  getPlatform: vi.fn().mockReturnValue('ios'),
}));
vi.mock('@/app/lib/open-external-url', () => ({
  openExternalUrl: vi.fn(),
}));
vi.mock('@/app/lib/analytics-capture', () => ({
  track: vi.fn(),
}));

const mockedGetPlatform = vi.mocked(getPlatform);
const mockedOpenExternalUrl = vi.mocked(openExternalUrl);
const mockedTrack = vi.mocked(track);

const TITLE = 'Boardsesh has a new app';
const CTA = 'Get the new app';
const FALLBACK_CTA = 'Open the store page instead';

beforeEach(() => {
  mockedGetPlatform.mockReset().mockReturnValue('ios');
  mockedOpenExternalUrl.mockReset();
  mockedTrack.mockReset();
});

describe('CapacitorRetirementScreen', () => {
  // Generous timeout: the first render in the file pays MUI + emotion's one-off
  // setup cost, which alone can exceed the 5s default under jsdom.
  it('is a dead end — the only actions lead to the store', () => {
    const { container } = render(<CapacitorRetirementScreen />);
    expect(screen.getByText(TITLE)).toBeTruthy();
    // querySelector rather than getByRole: the a11y-tree computation behind
    // getByRole takes seconds against MUI's stylesheets under jsdom.
    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
    // No close button, no "continue anyway" — just the two store actions.
    const buttonLabels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent);
    expect(buttonLabels).toEqual([CTA, FALLBACK_CTA]);
  }, 20000);

  it('opens the App Store app on iOS', () => {
    render(<CapacitorRetirementScreen />);
    screen.getByText(CTA).click();
    expect(mockedOpenExternalUrl).toHaveBeenCalledWith('itms-apps://itunes.apple.com/app/id6761350784');
    expect(mockedTrack).toHaveBeenCalledWith('App Install Click', {
      platform: 'ios',
      source: 'capacitor-retirement',
    });
  });

  it('opens the Play Store app on Android', () => {
    mockedGetPlatform.mockReturnValue('android');
    render(<CapacitorRetirementScreen />);
    screen.getByText(CTA).click();
    expect(mockedOpenExternalUrl).toHaveBeenCalledWith('market://details?id=com.boardsesh.app');
  });

  it('falls back to the https listing when the scheme hand-off is refused', () => {
    render(<CapacitorRetirementScreen />);
    screen.getByText(FALLBACK_CTA).click();
    expect(mockedOpenExternalUrl).toHaveBeenCalledWith('https://apps.apple.com/app/boardsesh/id6761350784');
    expect(mockedTrack).toHaveBeenCalledWith('App Install Click', {
      platform: 'ios',
      source: 'capacitor-retirement-fallback',
    });
  });
});
