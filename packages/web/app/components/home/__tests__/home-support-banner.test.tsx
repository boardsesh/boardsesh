// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const preferences = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<unknown> => null),
  setPreference: vi.fn(async (_key: string, _value: unknown): Promise<void> => {}),
}));

const CLOSED_MONTH_KEY = 'supportBanner:closedMonth';
const SUPPORTER_KEY = 'supportBanner:supporter';

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
    vi.setSystemTime(new Date('2026-12-03T09:00:00Z'));
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

  it('stays hidden for the rest of the month a visitor closed it in', async () => {
    storedPreferences({ [CLOSED_MONTH_KEY]: '2026-12' });
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
  });

  it('comes back at the start of the next month', async () => {
    storedPreferences({ [CLOSED_MONTH_KEY]: '2026-11' });
    await renderBanner();

    expect(screen.getByTestId('home-support-banner')).toBeTruthy();
  });

  it('remembers the month of a close in IndexedDB', async () => {
    await renderBanner();

    fireEvent.click(screen.getByLabelText(tFromCatalog('marketing', 'home.supportBanner.close')));

    expect(preferences.setPreference).toHaveBeenCalledWith(CLOSED_MONTH_KEY, '2026-12');
  });

  it('never shows again for someone who reached the thank-you page', async () => {
    storedPreferences({ [SUPPORTER_KEY]: true, [CLOSED_MONTH_KEY]: '2026-10' });
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
  });

  it('shows on every visit in the window until closed', async () => {
    await renderBanner();
    expect(screen.getByTestId('home-support-banner')).toBeTruthy();
    expect(preferences.setPreference).not.toHaveBeenCalled();
  });

  // Not in the page flow: showing it must not push the hero down.
  it('sits fixed over the page instead of in its flow', async () => {
    await renderBanner();

    const banner = screen.getByTestId('home-support-banner');
    expect(banner.parentElement?.className).toMatch(/strip/);
  });

  // A homepage held in a cache past the 7th must not show it.
  it('shows nothing once the browser clock is past the window', async () => {
    vi.setSystemTime(new Date('2026-12-08T09:00:00Z'));
    await renderBanner();

    expect(screen.queryByTestId('home-support-banner')).toBeNull();
    expect(preferences.getPreference).not.toHaveBeenCalled();
  });
});
