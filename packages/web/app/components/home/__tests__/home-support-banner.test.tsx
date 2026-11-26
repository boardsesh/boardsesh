// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import frenchMarketing from '@boardsesh/i18n/locales/fr/marketing.json';
import RuntimeHomeSupportBanner from '../runtime-home-support-banner';
import { MarketingCapabilitiesContext } from '../../marketing/marketing-capabilities-context';

const preferences = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<unknown> => null),
  setPreference: vi.fn(async (_key: string, _value: unknown): Promise<void> => {}),
}));

const copy = frenchMarketing.home.supportBanner;
const CLOSED_MONTH_KEY = 'supportBanner:closedMonth';
const SUPPORTER_KEY = 'supportBanner:supporter';

/** Answer the IndexedDB reads per key, as the real store would. */
function storedPreferences(values: Record<string, unknown>) {
  preferences.getPreference.mockImplementation(async (key: string) => values[key] ?? null);
}

vi.mock('@/app/lib/user-preferences-db', () => preferences);

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
  const view = render(<HomeSupportBanner copy={copy} />);
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

  it('asks for support and links to /support tagged with its src', async () => {
    await renderBanner();

    expect(screen.getByText(copy.text)).toBeTruthy();
    const link = screen.getByText(copy.cta).closest('a');
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

    fireEvent.click(screen.getByLabelText(copy.close));

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

  it('rechecks supporter preferences when returning from the support thank-you page', async () => {
    render(
      <MarketingCapabilitiesContext.Provider
        value={{ enableExpoAuthBridge: true, developerHref: '/docs', hasMonthlySupport: true }}
      >
        <RuntimeHomeSupportBanner copy={copy} />
      </MarketingCapabilitiesContext.Provider>,
    );
    expect(await screen.findByTestId('home-support-banner')).toBeTruthy();
    storedPreferences({ [SUPPORTER_KEY]: true });
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(screen.queryByTestId('home-support-banner')).toBeNull();
    expect(preferences.getPreference).toHaveBeenCalledWith(SUPPORTER_KEY);
  });
});
