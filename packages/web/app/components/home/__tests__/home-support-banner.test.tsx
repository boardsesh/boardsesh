// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const preferences = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<unknown> => null),
  setPreference: vi.fn(async (_key: string, _value: unknown): Promise<void> => {}),
}));

const DISMISSED_KEY = 'supportBanner:december2026:dismissed';
const VIEWS_KEY = 'supportBanner:december2026:views';

/** Answer the IndexedDB reads per key, as the real store would. */
function storedPreferences(values: Record<string, unknown>) {
  preferences.getPreference.mockImplementation(async (key: string) => values[key] ?? null);
}

vi.mock('@/app/lib/user-preferences-db', () => preferences);

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, { href: string; children?: React.ReactNode }>(
    ({ href, children, ...props }, ref) => (
      <a ref={ref} href={href} {...props}>
        {children}
      </a>
    ),
  ),
}));

const { default: HomeSupportBanner } = await import('../home-support-banner');

async function renderBanner() {
  const view = render(<HomeSupportBanner />);
  // Let the IndexedDB read settle.
  await act(async () => {});
  return view;
}

describe('HomeSupportBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-10T09:00:00Z'));
    preferences.getPreference.mockReset();
    storedPreferences({});
    preferences.setPreference.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks to go monthly and links to /support tagged with its src', async () => {
    await renderBanner();

    expect(screen.getByText(tFromCatalog('marketing', 'home.supportBanner.text'))).toBeTruthy();
    const link = screen.getByText(tFromCatalog('marketing', 'home.supportBanner.cta')).closest('a');
    expect(link?.getAttribute('href')).toBe('/support?src=web-home-banner');
  });

  it('stays hidden for a visitor who closed it', async () => {
    storedPreferences({ [DISMISSED_KEY]: true });
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
  });

  it('remembers a close in IndexedDB', async () => {
    await renderBanner();

    fireEvent.click(screen.getByLabelText(tFromCatalog('marketing', 'home.supportBanner.close')));

    expect(preferences.setPreference).toHaveBeenCalledWith(DISMISSED_KEY, true);
  });

  // At most 2 views per person for December (campaign plan, initiative 5).
  it('counts each view', async () => {
    storedPreferences({ [VIEWS_KEY]: 1 });
    await renderBanner();

    expect(screen.getByTestId('home-support-banner')).toBeTruthy();
    expect(preferences.setPreference).toHaveBeenCalledWith(VIEWS_KEY, 2);
  });

  it('starts the count at one on a first visit', async () => {
    await renderBanner();

    expect(preferences.setPreference).toHaveBeenCalledWith(VIEWS_KEY, 1);
  });

  it('stops showing after the second view', async () => {
    storedPreferences({ [VIEWS_KEY]: 2 });
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
    expect(preferences.setPreference).not.toHaveBeenCalled();
  });

  // Not in the page flow: showing it must not push the hero down.
  it('sits fixed over the page instead of in its flow', async () => {
    await renderBanner();

    const banner = screen.getByTestId('home-support-banner');
    expect(banner.parentElement?.className).toMatch(/strip/);
  });

  // A homepage held in a cache past 31 Dec must not show it.
  it('shows nothing once the browser clock is past the window', async () => {
    vi.setSystemTime(new Date('2027-01-02T09:00:00Z'));
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
    expect(preferences.getPreference).not.toHaveBeenCalled();
  });
});
